import { readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  addToManifest,
  buildManifestEntry,
  compileManifestValidator,
  redactReport
} from "../scripts/capture-fixture.mjs";
import worker from "../src/worker.js";
import { capturedManifest, capturedReports } from "./e2e/fixtures/captured-reports.js";
import { knownGoodBrowserReports } from "./e2e/fixtures/known-good-browsers.js";
import { createWorkerEnv } from "./worker-env.js";

const IP = "203.0.113.7";
const LAN_IP = "192.168.1.20";
const chrome = knownGoodBrowserReports[0];
const validateManifest = compileManifestValidator();

async function postReport(headers, client) {
  const response = await worker.fetch(new Request("https://tells.blowhorn.ai/api/report", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify(client)
  }), createWorkerEnv(), {});
  return response.json();
}

// What Download JSON saves for a Chrome visitor behind Cloudflare, with the fields the corpus must not keep.
function downloadedReport() {
  return postReport({
    ...chrome.headers,
    "cf-connecting-ip": IP,
    "cf-ipcountry": "GB",
    "x-forwarded-for": IP,
    cookie: "session=abc",
    origin: "https://tells.blowhorn.ai",
    referer: "https://tells.blowhorn.ai/?utm_source=newsletter"
  }, {
    ...chrome.client,
    page: {
      url: "https://tells.blowhorn.ai/?utm_source=newsletter#verdict",
      origin: "https://tells.blowhorn.ai",
      referrer: "https://news.example/thread/42"
    },
    browser: { ...chrome.client.browser, historyLength: 7 },
    surfaces: {
      ...chrome.client.surfaces,
      extensions: {
        enabled: true,
        checked: 1,
        detectedCount: 1,
        detected: [{ name: "uBlock Origin", url: "chrome-extension://cjpalhdlnbpafiamejdnhcphjbkeiagm/img/icon_128.png", kind: "image" }],
        results: []
      }
    },
    network: {
      ...chrome.client.network,
      webrtc: { supported: true, candidates: [{ address: IP, type: "srflx" }], publicIps: [IP], privateIps: [LAN_IP], mdnsHosts: [] }
    },
    consistency: { webrtcPublicIps: [IP] }
  });
}

function reasonIds(body) {
  return body.verdict.reasons.map((reason) => reason.id);
}

function manifestEntry(overrides = {}) {
  return buildManifestEntry({
    id: "brave-1-73-macos-15",
    kind: "human",
    browser: "Brave",
    browserVersion: "1.73",
    os: "macOS",
    osVersion: "15.1",
    privacy: ["Shields: block fingerprinting (strict)"],
    captured: "2026-11-13",
    ...overrides
  }, { droppedHeaders: ["cf-connecting-ip"], removedFields: ["client.browser.historyLength"] });
}

describe("capture fixture redaction", () => {
  it("keeps the browser's own headers and names the dropped ones", async () => {
    const { fixture, redaction } = redactReport(await downloadedReport());

    expect(fixture.headers).toEqual(chrome.headers);
    expect(redaction.droppedHeaders).toEqual(expect.arrayContaining([
      "cf-connecting-ip", "cf-ipcountry", "content-type", "cookie", "origin", "referer", "x-forwarded-for"
    ]));
  });

  it("removes history length, extension probes, WebRTC addresses and the page's query and referrer", async () => {
    const report = await downloadedReport();
    const { fixture, redaction } = redactReport(report);
    const text = JSON.stringify(fixture);

    expect(fixture.client.browser).not.toHaveProperty("historyLength");
    expect(fixture.client.surfaces).not.toHaveProperty("extensions");
    expect(fixture.client.network.webrtc).toEqual({ supported: true });
    expect(fixture.client.consistency).toEqual({});
    expect(fixture.client.page).toEqual({ url: "https://tells.blowhorn.ai/", origin: "https://tells.blowhorn.ai" });
    for (const secret of [IP, LAN_IP, "utm_source", "news.example", "session=abc", "uBlock"]) {
      expect(text).not.toContain(secret);
    }
    expect(redaction.removedFields).toEqual(expect.arrayContaining([
      "client.browser.historyLength",
      "client.surfaces.extensions",
      "client.consistency.webrtcPublicIps",
      "client.network.webrtc.publicIps",
      "client.network.webrtc.serverIp",
      "client.page.referrer",
      "client.page.url query and fragment"
    ]));
    expect(report.client.browser.historyLength).toBe(7);
  });

  it("leaves the readings the verdict uses alone and scores the same", async () => {
    const report = await downloadedReport();
    const { fixture } = redactReport(report);
    const again = await postReport(fixture.headers, fixture.client);

    for (const key of ["automation", "tells", "workers", "behavior", "interaction"]) {
      expect(fixture.client[key], key).toEqual(report.client[key]);
    }
    expect(fixture.client.fingerprints.webgl.supported).toBe(true);
    expect(again.verdict.classification).toBe(report.verdict.classification);
    expect(again.verdict.score).toBe(report.verdict.score);
    expect(reasonIds(again)).toEqual(reasonIds(report));
  });

  it("keeps only whether each fingerprint surface worked, not its values", async () => {
    const report = await postReport(chrome.headers, {
      ...chrome.client,
      fingerprints: {
        canvas: { supported: true, hash: "c4nv4s", dataUrlLength: 5120 },
        webgl: { supported: true, vendor: "Google Inc. (Apple)", renderer: "ANGLE (Apple, Apple M2, OpenGL 4.1)", extensions: ["EXT_a"], fingerprintHash: "w3bgl" },
        audio: { supported: true, hash: "4ud10", sampleRate: 44100 },
        fonts: { supported: true, detected: ["Menlo"], count: 1, hash: "f0nts" },
        webgpu: { supported: true, adapter: { vendor: "apple", architecture: "metal-3" } },
        cssMedia: { supported: false, error: "blocked" }
      }
    });
    const { fixture, redaction } = redactReport(report);
    const text = JSON.stringify(fixture);

    expect(fixture.client.fingerprints).toEqual({
      canvas: { supported: true },
      webgl: { supported: true },
      audio: { supported: true },
      fonts: { supported: true },
      webgpu: { supported: true },
      cssMedia: { supported: false, error: "blocked" }
    });
    for (const value of ["c4nv4s", "Apple M2", "4ud10", "Menlo", "f0nts", "metal-3", "w3bgl"]) {
      expect(text).not.toContain(value);
    }
    expect(redaction.removedFields).toEqual(expect.arrayContaining([
      "client.fingerprints.canvas.hash",
      "client.fingerprints.webgl.vendor",
      "client.fingerprints.webgl.renderer",
      "client.fingerprints.audio.hash"
    ]));
  });

  it("keeps the canvas error the verdict reads", () => {
    const { fixture } = redactReport({
      server: { headers: chrome.headers },
      client: { fingerprints: { canvas: { supported: false, hashError: "SecurityError" }, webgl: { supported: false } } }
    });

    expect(fixture.client.fingerprints).toEqual({ canvas: { supported: false, hashError: "SecurityError" }, webgl: { supported: false } });
  });

  it("drops consistency keys the Worker adds, including the IP-based timezone check", () => {
    const { fixture, redaction } = redactReport({
      server: { headers: chrome.headers },
      client: {
        consistency: {
          uaPlatformMismatch: { ua: "macOS", platform: "Windows" },
          timezoneMismatch: { browserTimezone: "Europe/London", ipTimezone: "Asia/Kolkata" },
          acceptLanguageMismatch: { requestLanguages: ["en"], browserLanguages: ["fr"] }
        }
      }
    });

    expect(fixture.client.consistency).toEqual({ uaPlatformMismatch: { ua: "macOS", platform: "Windows" } });
    expect(redaction.removedFields).toEqual(["client.consistency.acceptLanguageMismatch", "client.consistency.timezoneMismatch"]);
  });

  it("removes nothing from a fixture it already redacted", async () => {
    const { fixture } = redactReport(await downloadedReport());
    const again = redactReport({ server: { headers: fixture.headers }, client: fixture.client });

    expect(again.redaction).toEqual({ droppedHeaders: [], removedFields: [] });
    expect(again.fixture).toEqual(fixture);
  });

  it("asks for a Download JSON report when the request headers are missing", () => {
    expect(() => redactReport({ client: {} })).toThrow(/Download JSON/);
    expect(() => redactReport({ server: { headers: {} } })).toThrow(/Download JSON/);
  });
});

describe("fixture manifest", () => {
  it("accepts an entry built by the capture script", () => {
    const manifest = addToManifest({ schemaVersion: 1, fixtures: [] }, manifestEntry());

    expect(validateManifest(manifest), JSON.stringify(validateManifest.errors)).toBe(true);
    expect(manifest.fixtures[0]).toMatchObject({ file: "brave-1-73-macos-15.json", browser: { name: "Brave", version: "1.73" } });
  });

  it.each([
    ["an id with spaces", { id: "Brave on macOS" }],
    ["an unknown kind", { kind: "bot" }],
    ["a date that is not YYYY-MM-DD", { captured: "13/11/2026" }],
    ["a missing browser version", { browserVersion: undefined }]
  ])("rejects %s", (_label, overrides) => {
    expect(validateManifest(addToManifest({ schemaVersion: 1, fixtures: [] }, manifestEntry(overrides)))).toBe(false);
  });

  it("replaces an entry with the same id and keeps entries sorted by id", () => {
    let manifest = { schemaVersion: 1, fixtures: [] };
    manifest = addToManifest(manifest, manifestEntry({ id: "tor-14-macos-15" }));
    manifest = addToManifest(manifest, manifestEntry());
    manifest = addToManifest(manifest, manifestEntry({ browserVersion: "1.74" }));

    expect(manifest.fixtures.map((entry) => entry.id)).toEqual(["brave-1-73-macos-15", "tor-14-macos-15"]);
    expect(manifest.fixtures[0].browser.version).toBe("1.74");
  });
});

describe("known-good corpus", () => {
  it("matches the manifest schema", () => {
    expect(validateManifest(capturedManifest), JSON.stringify(validateManifest.errors)).toBe(true);
  });

  it("lists every capture file once, named after its id", () => {
    const files = readdirSync(new URL("./e2e/fixtures/captures/", import.meta.url)).filter((name) => name !== "manifest.json");
    const ids = capturedManifest.fixtures.map((entry) => entry.id);

    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of capturedManifest.fixtures) expect(entry.file).toBe(`${entry.id}.json`);
    expect(files.sort()).toEqual(capturedManifest.fixtures.map((entry) => entry.file).sort());
  });

  it("holds only redacted fixtures", () => {
    for (const capture of capturedReports) {
      const { redaction } = redactReport({ server: { headers: capture.headers }, client: capture.client });
      expect(redaction, capture.id).toEqual({ droppedHeaders: [], removedFields: [] });
    }
  });
});
