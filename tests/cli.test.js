import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CliError,
  EXIT,
  assertTellsBody,
  checkUrl,
  exitCodeForClassification,
  formatReport,
  formatVerdictLine,
  helpText,
  main,
  parseCliArgs,
  parseReportText,
  playwrightMissingMessage
} from "../src/cli.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/cli-report.json", import.meta.url), "utf8"));

function capture() {
  const out = [];
  const err = [];
  return {
    out,
    err,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text)
  };
}

describe("parseCliArgs", () => {
  it("recognizes --version and -V", () => {
    expect(parseCliArgs(["--version"])).toEqual({ version: true });
    expect(parseCliArgs(["-V"])).toEqual({ version: true });
  });

  it("defaults to the public site and a browser run", () => {
    const args = parseCliArgs([]);
    expect(args).toMatchObject({
      help: false,
      url: "https://tells.blowhorn.ai/",
      timeoutMs: 90_000,
      serverOnly: false,
      compact: false
    });
  });

  it("accepts a page URL, timeout, compact output, and server-only", () => {
    const args = parseCliArgs([
      "--url", "http://127.0.0.1:8787/path?q=1",
      "--timeout", "5000",
      "--compact",
      "--server-only"
    ]);
    expect(args.url).toBe("http://127.0.0.1:8787/path?q=1");
    expect(args.timeoutMs).toBe(5000);
    expect(args.compact).toBe(true);
    expect(args.serverOnly).toBe(true);
  });

  it("rejects an unknown flag, a bad URL, and a bad timeout", () => {
    expect(() => parseCliArgs(["--nope"])).toThrow(/unknown/i);
    expect(() => parseCliArgs(["--url", "ftp://example.test"])).toThrow(/http or https/);
    expect(() => parseCliArgs(["--timeout", "0"])).toThrow(/whole number/);
    expect(() => parseCliArgs(["--timeout", "50"])).toThrow(/1000/);
    expect(() => parseCliArgs(["report.json"])).toThrow();
  });

  it("prints the package.json version and exits 0 for --version and -V", async () => {
    const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    for (const flag of ["--version", "-V"]) {
      const io = capture();
      const code = await main([flag], io);
      expect(code).toBe(EXIT.LIKELY_HUMAN);
      expect(io.out).toEqual([version]);
      expect(io.err).toEqual([]);
    }
  });

  it("prints help and exits 0", async () => {
    const io = capture();
    const code = await main(["--help"], io);
    expect(code).toBe(EXIT.LIKELY_HUMAN);
    expect(io.out.join("\n")).toBe(helpText());
    expect(io.out[0]).toContain("0  classification likely_human, or --help / -h or --version / -V");
    expect(io.out[0]).toContain("3  classification suspicious");
    expect(io.out[0]).toContain("4  classification likely_bot");
    expect(io.err).toEqual([]);
  });
});

describe("exit codes and formatting", () => {
  it("maps the three classifications and rejects anything else", () => {
    expect(exitCodeForClassification("likely_human")).toBe(0);
    expect(exitCodeForClassification("suspicious")).toBe(3);
    expect(exitCodeForClassification("likely_bot")).toBe(4);
    expect(exitCodeForClassification("nope")).toBe(2);
  });

  it("formats the fixture as pretty JSON and a one-line verdict", () => {
    expect(JSON.parse(formatReport(fixture, false))).toEqual(fixture);
    expect(formatReport(fixture, false).startsWith("{\n")).toBe(true);
    expect(JSON.parse(formatReport(fixture, true))).toEqual(fixture);
    expect(formatReport(fixture, true).includes("\n")).toBe(false);
    expect(formatVerdictLine(fixture)).toBe("likely_human score=82");
  });

  it("reads a finished raw-report element and ignores the empty state", () => {
    expect(parseReportText("No report yet.")).toBeNull();
    expect(parseReportText(`\n${JSON.stringify(fixture)}\n`)).toEqual(fixture);
    expect(parseReportText("{")).toBeNull();
  });

  it("builds GET /api/check on the page origin", () => {
    expect(checkUrl("https://tells.blowhorn.ai/compare/?x=1#y").href).toBe("https://tells.blowhorn.ai/api/check");
    expect(checkUrl("https://tells.blowhorn.ai/api/check?x=1").search).toBe("?x=1");
  });
});

describe("main", () => {
  it("prints a server-only body and exits with the verdict", async () => {
    const suspicious = {
      ...fixture,
      verdict: { ...fixture.verdict, classification: "suspicious", score: 50 }
    };
    const io = capture();
    const code = await main(["--server-only", "--compact", "--url", "https://tells.example/"], {
      ...io,
      fetchImpl: async (url) => {
        expect(String(url)).toBe("https://tells.example/api/check");
        return { ok: true, status: 200, json: async () => suspicious };
      },
      playwright: { chromium: { launch: () => { throw new Error("browser should not launch"); } } }
    });
    expect(code).toBe(EXIT.SUSPICIOUS);
    expect(io.out).toEqual([formatReport(suspicious, true)]);
    expect(io.err).toEqual(["suspicious score=50"]);
  });

  it("prints a browser report and exits 4 for likely_bot", async () => {
    const bot = { ...fixture, verdict: { ...fixture.verdict, classification: "likely_bot", score: 10 } };
    const io = capture();
    const code = await main(["--url", "http://127.0.0.1:9/"], {
      ...io,
      playwright: {
        chromium: {
          launch: async () => ({
            newPage: async () => ({
              setDefaultTimeout() {},
              async goto(url) { expect(url).toBe("http://127.0.0.1:9/"); },
              async waitForFunction() {},
              locator() { return { textContent: async () => JSON.stringify(bot) }; }
            }),
            close: async () => {}
          })
        }
      }
    });
    expect(code).toBe(EXIT.LIKELY_BOT);
    expect(JSON.parse(io.out[0])).toEqual(bot);
    expect(io.err).toEqual(["likely_bot score=10"]);
  });

  it("exits 2 when the check endpoint fails and 1 on usage errors", async () => {
    const failed = capture();
    const failedCode = await main(["--server-only"], {
      ...failed,
      fetchImpl: async () => ({ ok: false, status: 429, json: async () => ({}) })
    });
    expect(failedCode).toBe(EXIT.RUN_FAILED);
    expect(failed.err[0]).toMatch(/429/);
    expect(failed.out).toEqual([]);

    const usage = capture();
    expect(await main(["--timeout", "nope"], usage)).toBe(EXIT.USAGE);
    expect(usage.out).toEqual([]);
  });

  it("rejects a body that is not schema_version 1", () => {
    expect(() => assertTellsBody({ ok: true, schema_version: 1 })).toThrow(/schema_version 1/);
    expect(() => assertTellsBody({ ...fixture, schema_version: 2 })).toThrow(/schema_version 1/);
  });

  it("exits 2 with the install step when Playwright or Chromium is missing", async () => {
    const missingLib = capture();
    const missingLibCode = await main([], {
      ...missingLib,
      loadPlaywright: async () => {
        throw new CliError(playwrightMissingMessage(), EXIT.RUN_FAILED);
      }
    });
    expect(missingLibCode).toBe(EXIT.RUN_FAILED);
    expect(missingLib.err[0]).toMatch(/Playwright is not installed/);
    expect(missingLib.err[0]).toMatch(/--server-only/);
    expect(missingLib.out).toEqual([]);

    const missingBrowser = capture();
    const missingBrowserCode = await main([], {
      ...missingBrowser,
      playwright: {
        chromium: {
          launch: async () => {
            throw new Error("Executable doesn't exist");
          }
        }
      }
    });
    expect(missingBrowserCode).toBe(EXIT.RUN_FAILED);
    expect(missingBrowser.err[0]).toMatch(/Could not launch Chromium/);
    expect(missingBrowser.err[0]).toMatch(/playwright install chromium/);
    expect(missingBrowser.err[0]).toMatch(/Executable doesn't exist/);
    expect(missingBrowser.out).toEqual([]);
  });
});
