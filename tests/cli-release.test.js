import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import { helpText } from "../src/cli.js";
import { distTagFor, versionFromTag } from "../scripts/release-version.mjs";
import {
  fetchLatestRelease,
  formulaClassName,
  formulaModel,
  main as renderMain,
  renderFormula
} from "../scripts/render-homebrew-formula.mjs";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(join(root, path), "utf8"));
const readText = (path) => readFileSync(join(root, path), "utf8");

const manifest = readJson("schemas/cli-release.json");
const schema = readJson("schemas/cli-release.schema.json");
const pkg = readJson("package.json");
const fixture = readJson("tests/fixtures/cli-report.json");
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

const SHA = "a".repeat(64);

function withChange(change) {
  const copy = structuredClone(manifest);
  change(copy);
  return copy;
}

// Node on PATH for the bin's `#!/usr/bin/env node`, and no npm_config_* leaking in from pnpm.
function childEnv(extraPath) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_/i.test(key)));
  env.PATH = [extraPath, dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter);
  return env;
}

async function runCommand(file, args, options = {}) {
  try {
    const { stdout, stderr } = await run(file, args, { encoding: "utf8", timeout: 60_000, ...options });
    return { code: 0, stdout, stderr };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

describe("CLI release manifest", () => {
  it("validates against its schema", () => {
    expect(validate(manifest), JSON.stringify(validate.errors)).toBe(true);
  });

  it.each([
    ["an unknown field", (m) => { m.package.extra = true; }],
    ["a missing npx entry", (m) => { delete m.npx; }],
    ["another license", (m) => { m.package.license = "MIT"; }],
    ["a scoped or uppercase package name", (m) => { m.package.name = "@Blowhorn/tells"; }],
    ["a tap repo without the homebrew- prefix", (m) => { m.homebrew.tap_repository = "blowhorn-ai/tap"; }],
    ["a formula that does not depend on node", (m) => { m.homebrew.depends_on = ["python"]; }],
    ["a desc ending in a period", (m) => { m.homebrew.desc = "Bot check."; }],
    ["a desc starting with an article", (m) => { m.homebrew.desc = "A bot check"; }],
    ["a desc that would break the Ruby string", (m) => { m.homebrew.desc = "Bot \"check\""; }],
    ["a desc over 80 characters", (m) => { m.homebrew.desc = "x".repeat(81); }],
    ["a non-https homepage", (m) => { m.package.homepage = "http://tells.blowhorn.ai"; }],
    ["a non-npm registry", (m) => { m.npm.registry = "https://registry.example"; }],
    ["an npx entry that is not a GitHub spec", (m) => { m.npx.command = "npx tells"; }]
  ])("rejects %s", (_, change) => {
    expect(validate(withChange(change))).toBe(false);
  });

  it("names one package, one command and one formula everywhere", () => {
    const { package: p, npm, homebrew, npx } = manifest;
    expect(npm.install).toBe(`npm i -g ${p.name}`);
    expect(homebrew.formula).toBe(p.bin);
    expect(homebrew.tap).toBe(homebrew.tap_repository.replace("/homebrew-", "/"));
    expect(homebrew.install).toBe(`brew install ${homebrew.tap}/${homebrew.formula}`);
    expect(npx.command).toBe(`npx github:${p.repository}`);
    expect(existsSync(join(root, ".github/workflows", npm.publish_workflow))).toBe(true);
    expect(existsSync(join(root, p.entry))).toBe(true);
  });
});

describe("package.json", () => {
  it("is a public package named blowhorn-tells that exposes the tells bin", () => {
    expect(pkg.private).toBeUndefined();
    expect(pkg.name).toBe(manifest.package.name);
    expect(Object.keys(pkg.bin)).toEqual([manifest.package.bin]);
    // npm rewrites "./bin/tells.js" to "bin/tells.js" and warns on publish, so require the normalized form.
    expect(pkg.bin[manifest.package.bin]).toBe(manifest.package.entry);
    expect(pkg.license).toBe(manifest.package.license);
    expect(pkg.homepage).toBe(manifest.package.homepage);
    expect(pkg.description).toBe(manifest.package.description);
    // npm provenance requires the repository to match the publishing GitHub repo.
    expect(pkg.repository).toEqual({ type: "git", url: `git+https://github.com/${manifest.package.repository}.git` });
    expect(pkg.bugs).toEqual({ url: `https://github.com/${manifest.package.repository}/issues` });
    expect(() => versionFromTag(`v${pkg.version}`)).not.toThrow();
  });

  it("keeps Playwright out of what an install pulls in", () => {
    for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "bundleDependencies"]) {
      expect(Object.keys(pkg[field] ?? {})).not.toContain("playwright");
      expect(Object.keys(pkg[field] ?? {})).not.toContain("@playwright/test");
    }
    expect(pkg.dependencies ?? {}).toEqual({});
  });
});

describe("packed package", () => {
  let work;
  let packed;
  let prefix;
  let server;
  let serverUrl;

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "tells-pack-"));
    const { stdout } = await run("npm", ["pack", "--json", "--pack-destination", work], {
      cwd: root,
      env: childEnv(),
      encoding: "utf8"
    });
    const result = JSON.parse(stdout);
    // npm 11 prints an array; npm 12 keys the result by package name.
    packed = Array.isArray(result) ? result[0] : Object.values(result)[0];

    prefix = join(work, "prefix");
    await run("npm", [
      "install", "--global", "--offline", "--no-audit", "--no-fund",
      "--prefix", prefix, "--cache", join(work, "npm-cache"),
      join(work, packed.filename)
    ], { env: childEnv(), encoding: "utf8" });

    server = createServer((request, response) => {
      if (request.url === "/api/check") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(fixture));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    serverUrl = `http://127.0.0.1:${server.address().port}/`;
  }, 120_000);

  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (work) rmSync(work, { recursive: true, force: true });
  });

  const installedBin = () => join(prefix, "bin", manifest.package.bin);

  it("ships the CLI runtime and docs, and nothing dev-only", () => {
    expect(packed.name).toBe(manifest.package.name);
    expect(packed.files.map((file) => file.path).sort()).toEqual([
      "LICENSE",
      "README.md",
      "bin/tells.js",
      "package.json",
      "schemas/cli-release.json",
      "src/cli.js"
    ]);
  });

  it.skipIf(process.platform === "win32")("puts tells on PATH after a global install, and --help exits 0 with usage", async () => {
    const result = await runCommand(manifest.package.bin, ["--help"], { env: childEnv(join(prefix, "bin")) });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(helpText());
    expect(result.stdout).toContain("Usage:");
    expect(result.stderr).toBe("");
  });

  it.skipIf(process.platform === "win32")("prints the package version for tells --version", async () => {
    const result = await runCommand(manifest.package.bin, ["--version"], { env: childEnv(join(prefix, "bin")) });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe(pkg.version);
    expect(result.stderr).toBe("");
  });

  it("packs and dry-run publishes without an invalid bin warning", async () => {
    for (const args of [["pack", "--dry-run"], ["publish", "--dry-run"]]) {
      const { stderr } = await run("npm", args, { cwd: root, env: childEnv(), encoding: "utf8" });
      expect(stderr).not.toMatch(/was invalid and removed/);
      expect(stderr).not.toMatch(/bin\[/);
    }
  }, 60_000);

  it.skipIf(process.platform === "win32")("runs --server-only with no Playwright installed", async () => {
    expect(existsSync(join(prefix, "lib/node_modules/playwright"))).toBe(false);
    const result = await runCommand(installedBin(), ["--server-only", "--compact", "--url", serverUrl], { env: childEnv() });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(fixture);
    expect(result.stderr.trim()).toBe(`${fixture.verdict.classification} score=${fixture.verdict.score}`);
  });

  it.skipIf(process.platform === "win32")("exits 2 and names the install step when the browser run has no Playwright", async () => {
    const result = await runCommand(installedBin(), ["--url", serverUrl, "--timeout", "1000"], { env: childEnv() });
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Playwright is not installed");
    expect(result.stderr).toContain("npm i -g playwright");
    expect(result.stderr).toContain("tells --server-only");
  });

  it.skipIf(process.platform === "win32")("loads a Playwright that is installed globally next to tells", async () => {
    // Stand-in for `npm i -g playwright`: same prefix, so the same lib/node_modules.
    const fake = join(prefix, "lib/node_modules/playwright");
    mkdirSync(fake, { recursive: true });
    writeFileSync(join(fake, "package.json"), JSON.stringify({ name: "playwright", type: "module", exports: "./index.js" }));
    writeFileSync(join(fake, "index.js"), 'export const chromium = { launch: async () => { throw new Error("stand-in Playwright loaded"); } };\n');
    try {
      const result = await runCommand(installedBin(), ["--url", serverUrl, "--timeout", "1000"], { env: childEnv() });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("Could not launch Chromium");
      expect(result.stderr).toContain("stand-in Playwright loaded");
    } finally {
      rmSync(fake, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("reports a Playwright that is installed but fails to load, instead of calling it missing", async () => {
    const fake = join(prefix, "lib/node_modules/playwright");
    mkdirSync(fake, { recursive: true });
    writeFileSync(join(fake, "package.json"), JSON.stringify({ name: "playwright", type: "module", exports: "./index.js" }));
    writeFileSync(join(fake, "index.js"), 'throw new Error("stand-in Playwright is broken");\n');
    try {
      const result = await runCommand(installedBin(), ["--url", serverUrl, "--timeout", "1000"], { env: childEnv() });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("Could not load Playwright: stand-in Playwright is broken");
      expect(result.stderr).not.toContain("Playwright is not installed");
    } finally {
      rmSync(fake, { recursive: true, force: true });
    }
  });

  it("runs --help from the unpacked tarball", async () => {
    const unpacked = join(work, "unpacked");
    mkdirSync(unpacked);
    await run("tar", ["-xzf", join(work, packed.filename), "-C", unpacked]);
    const result = await runCommand(process.execPath, [join(unpacked, "package", manifest.package.entry), "--help"], { env: childEnv() });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Usage:");
  });
});

describe("release tag to npm version", () => {
  it("strips the v from a semver tag and picks the dist-tag", () => {
    expect(versionFromTag("v0.3.12")).toBe("0.3.12");
    expect(versionFromTag("v1.0.0-rc.1")).toBe("1.0.0-rc.1");
    expect(distTagFor("0.3.12")).toBe("latest");
    expect(distTagFor("1.0.0-rc.1")).toBe("next");
    expect(distTagFor("1.0.0+build.5")).toBe("latest");
    expect(distTagFor("0.3.12", true)).toBe("next");
    expect(distTagFor("1.0.0-rc.1", true)).toBe("next");
  });

  it.each(["0.3.12", "v0.3", "v01.2.3", "release-0.3.12", "v0.3.12 ", "", undefined])("rejects %j", (tag) => {
    expect(() => versionFromTag(tag)).toThrow(/v plus a semver version/);
  });

  it("prints GITHUB_OUTPUT lines and exits 1 on a bad tag", async () => {
    const script = join(root, "scripts/release-version.mjs");
    const good = await runCommand(process.execPath, [script, "v0.3.12"]);
    expect(good).toEqual({ code: 0, stdout: "version=0.3.12\ndist_tag=latest\n", stderr: "" });
    const pre = await runCommand(process.execPath, [script, "v0.3.12", "--github-prerelease"]);
    expect(pre).toEqual({ code: 0, stdout: "version=0.3.12\ndist_tag=next\n", stderr: "" });
    const preEnv = await runCommand(process.execPath, [script, "v0.3.12"], { env: { ...process.env, GITHUB_PRERELEASE: "true" } });
    expect(preEnv).toEqual({ code: 0, stdout: "version=0.3.12\ndist_tag=next\n", stderr: "" });
    const bad = await runCommand(process.execPath, [script, "latest"]);
    expect(bad.code).toBe(1);
    expect(bad.stdout).toBe("");
    expect(bad.stderr).toMatch(/v plus a semver version/);
  });
});

// Reads the rendered Ruby back into the fields it declares. Every non-comment line must be
// understood, so a stray or misspelled stanza fails the test instead of passing unnoticed.
function readFormula(text) {
  const formula = { dependsOn: [], install: [], test: [] };
  let block = null;
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    let match;
    if ((match = /^class ([A-Z][A-Za-z0-9]*) < Formula$/.exec(line))) formula.className = match[1];
    else if ((match = /^ {2}(desc|homepage|url|sha256|license) "((?:[^"\\]|\\.)*)"$/.exec(line))) formula[match[1]] = match[2].replace(/\\(.)/g, "$1");
    else if ((match = /^ {2}depends_on "([^"]+)"$/.exec(line))) formula.dependsOn.push(match[1]);
    else if (line === "  def install") block = "install";
    else if (line === "  test do") block = "test";
    else if (line === "  end") block = null;
    else if (line === "end") break;
    else if (block && line.startsWith("    ")) formula[block].push(line.trim());
    else throw new Error(`Unexpected formula line: ${line}`);
  }
  return formula;
}

describe("Homebrew formula", () => {
  const model = formulaModel(manifest, { version: "0.3.12", sha256: SHA });

  it("models a tells formula that installs the tells CLI from the npm tarball and depends on node", () => {
    expect(model).toEqual({
      formula: "tells",
      className: "Tells",
      desc: manifest.homebrew.desc,
      homepage: "https://tells.blowhorn.ai",
      url: "https://registry.npmjs.org/blowhorn-tells/-/blowhorn-tells-0.3.12.tgz",
      sha256: SHA,
      license: "Apache-2.0",
      dependsOn: ["node"],
      install: { npmPackage: "blowhorn-tells", linkBins: ["tells"] },
      test: { command: "tells", args: ["--help"], expectOutput: "Usage:" }
    });
    // The test block's expectation is what tells --help really prints.
    expect(helpText()).toContain(model.test.expectOutput);
  });

  it("renders Ruby that declares exactly the model", () => {
    const formula = readFormula(renderFormula(model));
    expect(formula).toEqual({
      className: model.className,
      desc: model.desc,
      homepage: model.homepage,
      url: model.url,
      sha256: model.sha256,
      license: model.license,
      dependsOn: model.dependsOn,
      install: ['system "npm", "install", *std_npm_args', 'bin.install_symlink libexec.glob("bin/*")'],
      test: ['assert_match "Usage:", shell_output("#{bin}/tells --help")']
    });
  });

  it("is deterministic and escapes Ruby string metacharacters", () => {
    expect(renderFormula(model)).toBe(renderFormula(formulaModel(manifest, { version: "0.3.12", sha256: SHA })));
    const tricky = { ...model, desc: 'Say "hi" #{x} \\ ok' };
    expect(readFormula(renderFormula(tricky)).desc).toBe(tricky.desc);
  });

  it("maps formula names to Homebrew class names", () => {
    expect(formulaClassName("tells")).toBe("Tells");
    expect(formulaClassName("foo-bar2")).toBe("FooBar2");
  });

  it("rejects a bad version or sha256", () => {
    expect(() => formulaModel(manifest, { version: "v0.3.12", sha256: SHA })).toThrow(/semver/);
    expect(() => formulaModel(manifest, { version: "0.3.12", sha256: "A".repeat(64) })).toThrow(/sha256/);
    expect(() => formulaModel(manifest, { version: "0.3.12" })).toThrow(/sha256/);
  });
});

describe("Homebrew formula from the npm registry", () => {
  const tarball = Buffer.from("pretend tarball bytes");
  const sha512 = createHash("sha512").update(tarball).digest("base64");
  const sha256 = createHash("sha256").update(tarball).digest("hex");
  const tarballUrl = "https://registry.npmjs.org/blowhorn-tells/-/blowhorn-tells-0.3.12.tgz";

  function registry(meta, bytes = tarball) {
    const calls = [];
    const fetchImpl = async (url) => {
      calls.push(String(url));
      if (url === "https://registry.npmjs.org/blowhorn-tells/latest") return new Response(JSON.stringify(meta));
      if (url === tarballUrl) return new Response(bytes);
      return new Response("not found", { status: 404 });
    };
    return { calls, fetchImpl };
  }

  const goodMeta = { version: "0.3.12", dist: { tarball: tarballUrl, integrity: `sha512-${sha512}` } };

  it("reads the latest version and the sha256 of its verified tarball", async () => {
    const { calls, fetchImpl } = registry(goodMeta);
    await expect(fetchLatestRelease(manifest, fetchImpl)).resolves.toEqual({ version: "0.3.12", sha256 });
    expect(calls).toEqual(["https://registry.npmjs.org/blowhorn-tells/latest", tarballUrl]);
  });

  it("refuses a tarball that does not match the registry integrity", async () => {
    const { fetchImpl } = registry(goodMeta, Buffer.from("tampered"));
    await expect(fetchLatestRelease(manifest, fetchImpl)).rejects.toThrow(/does not match the registry sha512/);
  });

  it("refuses a tarball URL outside the official registry path", async () => {
    const { fetchImpl } = registry({ ...goodMeta, dist: { ...goodMeta.dist, tarball: "https://evil.example/t.tgz" } });
    await expect(fetchLatestRelease(manifest, fetchImpl)).rejects.toThrow(/is not https:\/\/registry\.npmjs\.org/);
  });

  it("refuses metadata without a sha512 integrity or a semver version", async () => {
    await expect(fetchLatestRelease(manifest, registry({ ...goodMeta, dist: { tarball: tarballUrl } }).fetchImpl)).rejects.toThrow(/sha512 SRI/);
    await expect(fetchLatestRelease(manifest, registry({ ...goodMeta, version: "latest" }).fetchImpl)).rejects.toThrow(/semver/);
  });

  it("names the failing request when the registry is unreachable or errors", async () => {
    await expect(fetchLatestRelease(manifest, async () => new Response("", { status: 503 }))).rejects.toThrow(/package metadata\) returned 503/);
    await expect(fetchLatestRelease(manifest, async () => { throw new Error("offline"); })).rejects.toThrow(/failed: offline/);
  });

  it("writes Formula/tells.rb with --from-npm and prints the formula and version", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tells-formula-"));
    try {
      const out = join(dir, "Formula", "tells.rb");
      let printed = "";
      const release = await renderMain(["--from-npm", "--out", out], {
        fetchImpl: registry(goodMeta).fetchImpl,
        stdout: { write: (text) => { printed += text; } }
      });
      expect(release).toEqual({ version: "0.3.12", sha256 });
      expect(printed).toBe("tells 0.3.12\n");
      const formula = readFormula(readFileSync(out, "utf8"));
      expect(formula.url).toBe(tarballUrl);
      expect(formula.sha256).toBe(sha256);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("requires either --from-npm or an explicit version and sha256", async () => {
    await expect(renderMain([])).rejects.toThrow(/either --from-npm/);
    await expect(renderMain(["--from-npm", "--version", "0.3.12"])).rejects.toThrow(/either --from-npm/);
    await expect(renderMain(["--version", "0.3.12"], { stdout: { write() {} } })).rejects.toThrow(/sha256/);
  });
});

describe("install docs", () => {
  const surfaces = {
    "README.md": readText("README.md"),
    "public/llms.txt": readText("public/llms.txt"),
    "public/agents/index.html": readText("public/agents/index.html"),
    "tells --help": helpText()
  };

  it.each(Object.keys(surfaces))("%s leads with the manifest's one-time installs and keeps npx as the fallback", (name) => {
    const text = surfaces[name];
    const npmAt = text.indexOf(manifest.npm.install);
    const brewAt = text.indexOf(manifest.homebrew.install);
    const npxAt = text.indexOf(manifest.npx.command);
    expect(npmAt, "npm install").toBeGreaterThanOrEqual(0);
    expect(brewAt, "brew install").toBeGreaterThanOrEqual(0);
    expect(npxAt, "npx fallback").toBeGreaterThan(npmAt);
    expect(npxAt, "npx fallback").toBeGreaterThan(brewAt);
    expect(text).not.toMatch(/stays private on npm/);
    expect(text).not.toContain("—");
  });
});
