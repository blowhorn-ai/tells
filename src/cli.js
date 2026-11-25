// Public CLI. Stdout is a schema_version 1 body (report or check). Stderr is one verdict line.
// Exit codes are documented in --help and the README.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

export const DEFAULT_URL = "https://tells.blowhorn.ai/";
export const DEFAULT_TIMEOUT_MS = 90_000;

export const EXIT = {
  LIKELY_HUMAN: 0,
  USAGE: 1,
  RUN_FAILED: 2,
  SUSPICIOUS: 3,
  LIKELY_BOT: 4
};

export class CliError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

// schemas/cli-release.json is the source of truth for the install commands. It ships in the
// npm package next to this file. Read lazily: only --help and the Playwright-missing message use it.
export function releaseManifest() {
  return JSON.parse(readFileSync(new URL("../schemas/cli-release.json", import.meta.url), "utf8"));
}

// The version is whatever package.json says. The publish workflow rewrites it from the release tag.
export function packageVersion() {
  return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
}

export function helpText(manifest = releaseManifest()) {
  return `tells - run Blowhorn Tells and print the report

Install once, then run tells:
  ${manifest.npm.install}
  ${manifest.homebrew.install}
Without a global install: ${manifest.npx.command}

Usage:
  tells [--url <url>] [--timeout <ms>] [--compact] [--no-collect]
  tells --server-only [--url <url>] [--timeout <ms>] [--compact]
  tells --help
  tells --version

The default run opens <url> in headless Chromium through Playwright and prints
the JSON in [data-tells-report="raw"] (the POST /api/report body,
schemas/report.schema.json, schema_version 1). Playwright is optional: it is
not a dependency of the ${manifest.package.name} package, so none of the installs
above add it. If Playwright or Chromium is missing the command exits 2 and names
the install step.

--server-only calls GET /api/check on the same origin and prints that body
(schemas/check.schema.json, schema_version 1). No browser.

Stdout is the JSON only. Stderr is one line: "<classification> score=<n>".
The command does not write the report to disk.

Exit codes:
  0  classification likely_human, or --help / -h or --version / -V (output on stdout)
  1  usage error
  2  the run failed (browser, network, timeout, or a body that is not schema_version 1)
  3  classification suspicious
  4  classification likely_bot

A stock headless browser is expected to score likely_bot. That exit code means
the check ran. It does not mean the CLI failed.`;
}

export function parseCliArgs(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: false,
      strict: true,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "V" },
        url: { type: "string" },
        timeout: { type: "string" },
        "server-only": { type: "boolean" },
        compact: { type: "boolean" },
        "no-collect": { type: "boolean" }
      }
    });
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error), EXIT.USAGE);
  }

  if (parsed.values.help) {
    return { help: true };
  }
  if (parsed.values.version) {
    return { version: true };
  }

  const url = parsed.values.url ?? DEFAULT_URL;
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new CliError(`Invalid --url: ${url}`, EXIT.USAGE);
  }
  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    throw new CliError(`--url must be http or https: ${url}`, EXIT.USAGE);
  }

  // The page keeps a redacted copy of each run unless the visitor opts out. The page reads this parameter.
  if (parsed.values["no-collect"] === true) parsedUrl.searchParams.set("collect", "off");

  return {
    help: false,
    url: parsedUrl.toString(),
    timeoutMs: parseTimeout(parsed.values.timeout),
    serverOnly: parsed.values["server-only"] === true,
    compact: parsed.values.compact === true
  };
}

export function parseTimeout(value) {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new CliError("--timeout must be a whole number of milliseconds.", EXIT.USAGE);
  }
  const timeoutMs = Number(value);
  if (timeoutMs < 1000 || timeoutMs > 300_000) {
    throw new CliError("--timeout must be from 1000 to 300000.", EXIT.USAGE);
  }
  return timeoutMs;
}

export function exitCodeForClassification(classification) {
  if (classification === "likely_human") return EXIT.LIKELY_HUMAN;
  if (classification === "suspicious") return EXIT.SUSPICIOUS;
  if (classification === "likely_bot") return EXIT.LIKELY_BOT;
  return EXIT.RUN_FAILED;
}

export function assertTellsBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new CliError("Response is not a schema_version 1 Tells body.", EXIT.RUN_FAILED);
  }
  if (body.schema_version !== 1 || body.ok !== true || !body.verdict || typeof body.verdict !== "object") {
    throw new CliError("Response is not a schema_version 1 Tells body.", EXIT.RUN_FAILED);
  }
  if (exitCodeForClassification(body.verdict.classification) === EXIT.RUN_FAILED) {
    throw new CliError("Response verdict has no known classification.", EXIT.RUN_FAILED);
  }
  if (!Number.isInteger(body.verdict.score)) {
    throw new CliError("Response verdict has no integer score.", EXIT.RUN_FAILED);
  }
  return body;
}

export function formatReport(body, compact) {
  return JSON.stringify(body, null, compact ? undefined : 2);
}

export function formatVerdictLine(body) {
  return `${body.verdict.classification} score=${body.verdict.score}`;
}

export function checkUrl(pageUrl) {
  const url = new URL(pageUrl);
  if (url.pathname !== "/api/check") {
    url.pathname = "/api/check";
    url.search = "";
    url.hash = "";
  }
  return url;
}

export function parseReportText(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    return assertTellsBody(JSON.parse(trimmed));
  } catch {
    return null;
  }
}

export async function fetchCheck(pageUrl, timeoutMs, fetchImpl = globalThis.fetch) {
  const url = checkUrl(pageUrl);
  let response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new CliError(`GET ${url} failed: ${error instanceof Error ? error.message : error}`, EXIT.RUN_FAILED);
  }
  if (!response.ok) {
    throw new CliError(`GET ${url} returned ${response.status}.`, EXIT.RUN_FAILED);
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new CliError(`GET ${url} did not return JSON.`, EXIT.RUN_FAILED);
  }
  return assertTellsBody(body);
}

export async function runBrowser(pageUrl, timeoutMs, playwrightImpl, loadPlaywrightImpl) {
  const playwright = playwrightImpl ?? await (loadPlaywrightImpl ?? loadPlaywright)();
  let browser;
  try {
    browser = await playwright.chromium.launch({ headless: true });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CliError(
      `Could not launch Chromium. Run \`npx playwright install chromium\` (from a checkout, \`pnpm exec playwright install chromium\`). Or run \`tells --server-only\` to call GET /api/check with no browser. ${detail}`,
      EXIT.RUN_FAILED
    );
  }
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(timeoutMs);
    await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForFunction(() => {
      const text = document.querySelector('[data-tells-report="raw"]')?.textContent?.trim() ?? "";
      return text.startsWith("{");
    }, undefined, { timeout: timeoutMs });
    const text = await page.locator('[data-tells-report="raw"]').textContent();
    const report = parseReportText(text);
    if (!report) {
      throw new CliError("The page did not produce a schema_version 1 report.", EXIT.RUN_FAILED);
    }
    return report;
  } finally {
    if (browser) await browser.close();
  }
}

// Node resolves "playwright" from this package's own directory upward. A global npm install
// of Playwright sits next to a global npm install of tells, so that pairing loads. A Homebrew
// install keeps tells in its own prefix, where no Playwright is found.
export function playwrightMissingMessage(manifest = releaseManifest()) {
  return `Playwright is not installed where tells can load it. With \`${manifest.npm.install}\`, add it with \`npm i -g playwright && npx playwright install chromium\`; a Homebrew install cannot load Playwright, so use the npm install for browser runs. From a checkout run \`pnpm exec playwright install chromium\`. Or run \`tells --server-only\` to call GET /api/check with no browser. The README documents a live browser pass.`;
}

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch (error) {
    // Only a missing package means "install it". A Playwright that is present but fails to load
    // (a broken or partial install) is reported as itself, so its real cause is not hidden.
    const missing = error?.code === "ERR_MODULE_NOT_FOUND" && /['"]playwright['"]/.test(String(error.message));
    if (missing) throw new CliError(playwrightMissingMessage(), EXIT.RUN_FAILED);
    throw new CliError(`Could not load Playwright: ${error instanceof Error ? error.message : String(error)}`, EXIT.RUN_FAILED);
  }
}

export async function main(argv, io = {}) {
  const stdout = io.stdout ?? ((text) => process.stdout.write(`${text}\n`));
  const stderr = io.stderr ?? ((text) => process.stderr.write(`${text}\n`));
  const fetchImpl = io.fetchImpl ?? globalThis.fetch;
  const playwrightImpl = io.playwright;
  const loadPlaywrightImpl = io.loadPlaywright;

  let args;
  try {
    args = parseCliArgs(argv);
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    return EXIT.USAGE;
  }

  if (args.help) {
    stdout(helpText());
    return EXIT.LIKELY_HUMAN;
  }

  if (args.version) {
    stdout(packageVersion());
    return EXIT.LIKELY_HUMAN;
  }

  try {
    const body = args.serverOnly
      ? await fetchCheck(args.url, args.timeoutMs, fetchImpl)
      : await runBrowser(args.url, args.timeoutMs, playwrightImpl, loadPlaywrightImpl);
    stdout(formatReport(body, args.compact));
    stderr(formatVerdictLine(body));
    return exitCodeForClassification(body.verdict.classification);
  } catch (error) {
    stderr(error instanceof Error ? error.message : String(error));
    return error instanceof CliError ? error.exitCode : EXIT.RUN_FAILED;
  }
}
