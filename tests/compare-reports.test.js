import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { compareReports, parseReportText } from "../public/compare-reports.js";

const ajv = new Ajv2020({ allErrors: true });
const validate = ajv.compile(JSON.parse(readFileSync(new URL("../schemas/report-comparison.schema.json", import.meta.url), "utf8")));

const MARKERS = {
  ip: "203.0.113.44",
  webrtc: "192.0.2.55",
  history: 9173,
  extension: "ProbeExtensionMarker",
  hash: "cafebabemarkerhash",
  gpu: "MarkerGPURenderer9000",
  font: "Marker Font Ligature"
};

function report(overrides = {}) {
  return {
    schema_version: 1,
    verdict: {
      classification: "likely_human",
      score: 92,
      reasons: []
    },
    server: {
      ip: MARKERS.ip,
      userAgent: "Mozilla/5.0",
      headers: { "user-agent": "Mozilla/5.0", "accept-language": "en" },
      cf: { httpProtocol: "HTTP/2", asOrganization: "Example Telecom", tlsVersion: "TLSv1.3" },
      datacenterHeuristic: { isLikelyDatacenter: false, organization: "Example Telecom" },
      proxyHeaders: {},
      ipIntel: { enabled: true, normalized: { isVpn: false, isProxy: false, isTor: false, isDatacenter: false } }
    },
    client: {
      browser: {
        webdriver: false,
        historyLength: MARKERS.history,
        userAgent: "Mozilla/5.0",
        languages: ["en"],
        plugins: [{}],
        hardwareConcurrency: 8,
        screen: { width: 1440, height: 900 }
      },
      surfaces: { extensions: [{ name: MARKERS.extension }] },
      fingerprints: {
        canvas: { supported: true, hash: MARKERS.hash },
        webgl: { supported: true, params: { unmaskedRenderer: MARKERS.gpu, vendor: "MarkerVendor" } },
        fonts: { supported: true, count: 12, list: [MARKERS.font] }
      },
      network: {
        webrtc: {
          supported: true,
          publicIps: [MARKERS.webrtc],
          candidates: [{ address: MARKERS.webrtc, port: 9, type: "srflx" }]
        }
      },
      page: { url: "https://tells.example/path?secret=1", referrer: "https://secret.example/from" }
    },
    ...overrides
  };
}

function asText(value) {
  return JSON.stringify(value);
}

function expectSchema(comparison) {
  expect(validate(comparison), JSON.stringify(validate.errors)).toBe(true);
}

function renderedBlob(comparison) {
  return JSON.stringify(comparison);
}

describe("compareReports", () => {
  it("reports identical verdict, checks and flags", () => {
    const comparison = compareReports(asText(report()), asText(report()));
    expectSchema(comparison);
    expect(comparison.versionWarning).toBeNull();
    expect(comparison.verdict.changed).toBe(false);
    expect(comparison.verdict.left).toEqual({ label: "Looks human", score: 92, classification: "likely_human" });
    expect(comparison.verdict.right).toEqual(comparison.verdict.left);
    expect(comparison.verdict.reasonChanges).toEqual([]);
    expect(comparison.checks.every((row) => row.changed === false)).toBe(true);
    expect(comparison.flags.every((flag) => flag.changed === false)).toBe(true);
  });

  it("diffs a different verdict label, score and reason", () => {
    const bot = report({
      verdict: {
        classification: "likely_bot",
        score: 20,
        reasons: [{ id: "navigator_webdriver", severity: "high", message: "webdriver", data: { ip: MARKERS.ip } }]
      },
      client: {
        ...report().client,
        browser: { ...report().client.browser, webdriver: true }
      }
    });
    const comparison = compareReports(asText(report()), asText(bot));
    expectSchema(comparison);
    expect(comparison.verdict.changed).toBe(true);
    expect(comparison.verdict.left.label).toBe("Looks human");
    expect(comparison.verdict.right.label).toBe("Looks like a bot");
    expect(comparison.verdict.left.score).toBe(92);
    expect(comparison.verdict.right.score).toBe(20);
    expect(comparison.verdict.reasonChanges).toEqual([
      {
        id: "navigator_webdriver",
        headline: "WebDriver detected",
        change: "added",
        leftSeverity: null,
        rightSeverity: "High"
      }
    ]);
    const browser = comparison.checks.find((row) => row.name === "Browser data");
    expect(browser.changed).toBe(true);
    expect(browser.left.status).toBe("pass");
    expect(browser.right.status).toBe("fail");
    expect(browser.right.summary).toBe("WebDriver detected");
    const automation = comparison.flags.find((flag) => flag.key === "automation");
    expect(automation.changed).toBe(true);
    expect(automation.right.sentence).toContain("WebDriver detected");
  });

  it("still diffs overlapping fields when a report is missing readings", () => {
    const thin = report();
    delete thin.client.fingerprints;
    delete thin.client.browser;
    const comparison = compareReports(asText(report()), asText(thin));
    expectSchema(comparison);
    const browser = comparison.checks.find((row) => row.name === "Browser data");
    const graphics = comparison.checks.find((row) => row.name === "Browser fingerprint");
    expect(browser.left.status).not.toBe("na");
    expect(browser.right.status).toBe("na");
    expect(graphics.changed).toBe(true);
    expect(graphics.right.summary.length).toBeGreaterThan(0);
  });

  it("rejects invalid JSON and a file that is not a Tells report", () => {
    const invalid = compareReports("{", asText(report()));
    expectSchema(invalid);
    expect(invalid.verdict).toBeNull();
    expect(invalid.sides[0].accepted).toBe(false);
    expect(invalid.sides[0].error).toMatch(/not valid JSON/);
    expect(invalid.sides[1].accepted).toBe(true);

    const foreign = parseReportText(JSON.stringify({ hello: "world" }));
    expect(foreign.ok).toBe(false);
    expect(foreign.error).toMatch(/not a Tells report/);

    const empty = compareReports("   ", "");
    expect(empty.sides.map((side) => side.error).join(" ")).toMatch(/Paste or drop/);
  });

  it("warns when schema_version is missing or the versions differ, and still diffs", () => {
    const older = report();
    delete older.schema_version;
    const missing = compareReports(asText(report()), asText(older));
    expectSchema(missing);
    expect(missing.versionWarning).toMatch(/same schema version/);
    expect(missing.verdict.changed).toBe(false);
    expect(missing.sides[1].schemaVersion).toBeNull();

    const next = report({ schema_version: 2, verdict: { classification: "suspicious", score: 50, reasons: [] } });
    const mismatch = compareReports(asText(report()), asText(next));
    expectSchema(mismatch);
    expect(mismatch.versionWarning).toMatch(/same schema version/);
    expect(mismatch.verdict.left.label).toBe("Looks human");
    expect(mismatch.verdict.right.label).toBe("Hard to tell");
    expect(mismatch.checks.length).toBeGreaterThan(0);
  });

  it("does not render sensitive fields that an old download may still contain", () => {
    const dirty = report({
      verdict: {
        classification: "suspicious",
        score: 60,
        reasons: [{
          id: "webrtc_public_ip_mismatch",
          severity: "high",
          message: `WebRTC exposed ${MARKERS.webrtc}`,
          data: { serverIp: MARKERS.ip, publicIps: [MARKERS.webrtc] }
        }]
      }
    });
    const blob = renderedBlob(compareReports(asText(report()), asText(dirty)));
    for (const marker of Object.values(MARKERS)) {
      expect(blob).not.toContain(String(marker));
    }
    expect(blob).not.toContain("secret.example");
    expect(blob).not.toContain("unmaskedRenderer");
    expect(blob).toContain("WebRTC address differs from the request");
  });
});
