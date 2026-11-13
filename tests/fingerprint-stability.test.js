import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyStability, STABILITY_CLASSES, STABILITY_SURFACES } from "../public/fingerprint-stability.js";
import { validateFingerprintStability } from "../public/generated/validate-fingerprint-stability.js";
import { buildValidatorSource, VALIDATORS } from "../scripts/build-validators.mjs";
import { deriveFingerprintStability, scoreReport } from "../src/report-verdict.js";
import worker from "../src/worker.js";
import { knownGoodBrowserReports } from "./e2e/fixtures/known-good-browsers.js";
import { createWorkerEnv } from "./worker-env.js";

const schema = JSON.parse(readFileSync(new URL("../schemas/fingerprint-stability.schema.json", import.meta.url), "utf8"));
const chrome = knownGoodBrowserReports[0];

function entry(overrides = {}) {
  return { reads: 3, distinct: 1, workerMatch: true, iframeMatch: true, controlAltered: false, classification: "stable", ...overrides };
}

function reasonIds(verdict) {
  return verdict.reasons.map((reason) => reason.id);
}

describe("stability classification", () => {
  it.each([
    ["stable", {}],
    ["blocked", { distinct: 0, workerMatch: null, iframeMatch: null }],
    ["randomized_per_read", { distinct: 3, workerMatch: false, iframeMatch: false }],
    ["context_inconsistent", { workerMatch: false }],
    ["context_inconsistent", { iframeMatch: false, controlAltered: true }],
    ["randomized_session", { controlAltered: true }],
    ["stable", { workerMatch: null, iframeMatch: null, controlAltered: null }]
  ])("classifies %s", (expected, overrides) => {
    expect(classifyStability(entry(overrides))).toBe(expected);
  });

  it("covers the surfaces and classes the schema allows", () => {
    expect(Object.keys(schema.properties)).toEqual([...STABILITY_SURFACES]);
    expect(schema.$defs.surface.properties.classification.enum).toEqual([...STABILITY_CLASSES]);
  });
});

describe("stability validator", () => {
  it("regenerates byte-identical output, so the committed validator is the schema's", () => {
    const validator = VALIDATORS.find((item) => item.exportName === "validateFingerprintStability");
    const committed = readFileSync(new URL(`../${validator.outputPath}`, import.meta.url), "utf8");
    expect(buildValidatorSource(undefined, validator)).toBe(committed);
  });

  it("accepts counts and classes, and rejects anything that carries a value", () => {
    expect(validateFingerprintStability({ canvas: entry(), voices: entry({ workerMatch: null }) })).toBe(true);
    expect(validateFingerprintStability({ canvas: { ...entry(), hash: "abc" } })).toBe(false);
    expect(validateFingerprintStability({ battery: entry() })).toBe(false);
    expect(validateFingerprintStability({ canvas: entry({ classification: "spoofed" }) })).toBe(false);
  });
});

describe("server stability scoring", () => {
  it("re-derives each class from the counts and ignores the class the page sent", () => {
    const derived = deriveFingerprintStability({ canvas: entry({ workerMatch: false, classification: "stable" }) });
    expect(derived.canvas.classification).toBe("context_inconsistent");
  });

  it("drops a report that is malformed or has impossible counts", () => {
    expect(deriveFingerprintStability(undefined)).toBeUndefined();
    expect(deriveFingerprintStability({ canvas: { reads: 3 } })).toBeNull();
    expect(deriveFingerprintStability({ canvas: entry({ distinct: 4 }) })).toBeNull();
  });

  it("scores a context mismatch as medium and randomization at 0 points", () => {
    const base = scoreReport({ server: { userAgent: "x" }, client: { fingerprints: {} } });
    const inconsistent = scoreReport({ server: { userAgent: "x" }, client: { fingerprints: { stability: { canvas: entry({ workerMatch: false }) } } } });
    const randomized = scoreReport({ server: { userAgent: "x" }, client: { fingerprints: { stability: { canvas: entry({ distinct: 3 }), audio: entry({ controlAltered: true }) } } } });

    expect(inconsistent.reasons.find((reason) => reason.id === "fingerprint_context_inconsistent")).toMatchObject({ severity: "medium", points: 15, data: ["canvas"] });
    expect(inconsistent.score).toBe(base.score - 15);
    expect(randomized.reasons.find((reason) => reason.id === "fingerprint_randomized")).toMatchObject({ severity: "low", points: 0, data: ["canvas", "audio"] });
    expect(randomized.score).toBe(base.score);
  });

  it("returns the server-derived classes in the report and drops an invalid one", async () => {
    const post = async (stability) => {
      const response = await worker.fetch(new Request("https://tells.blowhorn.ai/api/report", {
        method: "POST",
        headers: { ...chrome.headers, "content-type": "application/json" },
        body: JSON.stringify({ ...chrome.client, fingerprints: { ...chrome.client.fingerprints, stability } })
      }), createWorkerEnv(), {});
      return response.json();
    };
    const spoofed = await post({ canvas: entry({ workerMatch: false, classification: "stable" }) });
    const invalid = await post({ canvas: { ...entry(), hash: "abc" } });

    expect(spoofed.client.fingerprints.stability.canvas.classification).toBe("context_inconsistent");
    expect(reasonIds(spoofed.verdict)).toContain("fingerprint_context_inconsistent");
    expect(invalid.client.fingerprints).not.toHaveProperty("stability");
    expect(reasonIds(invalid.verdict)).not.toContain("fingerprint_context_inconsistent");
  });
});
