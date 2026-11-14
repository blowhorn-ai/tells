import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildCheckRows } from "../public/checks-view-model.js";
import { surface } from "../public/collect-stability.js";
import { classifyStability, STABILITY_CLASSES, STABILITY_SURFACES } from "../public/fingerprint-stability.js";
import { validateFingerprintStability } from "../public/generated/validate-fingerprint-stability.js";
import { redactReport } from "../scripts/capture-fixture.mjs";
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

  it("builds an entry from the reads the page compares", () => {
    expect(surface({ values: ["a", "a", "a"], frame: "a" }, "a", false)).toEqual(entry());
    expect(surface({ values: ["a", "a", "a"], frame: "a" }, "b", false).classification).toBe("context_inconsistent");
    expect(surface({ values: ["a", "b", "c"], frame: "d" }, "e", false)).toMatchObject({ distinct: 3, workerMatch: null, iframeMatch: null, classification: "randomized_per_read" });
    expect(surface({ values: [null, null, null], frame: null }, undefined, null)).toMatchObject({ distinct: 0, classification: "blocked" });
    expect(surface({ values: ["a", "a", "a"], frame: null }, undefined, null)).toMatchObject({ workerMatch: null, iframeMatch: null, classification: "stable" });
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

describe("Fingerprint protection row", () => {
  const row = (stability, reasons = []) => buildCheckRows({ verdict: { reasons }, client: { fingerprints: { stability } } })
    .find((item) => item.name === "Fingerprint protection");

  it("passes and names randomized or blocked surfaces, since they are info-only", () => {
    const result = row({ canvas: entry({ classification: "randomized_session" }), audio: entry({ classification: "randomized_per_read" }), voices: entry({ classification: "blocked" }) });
    expect(result).toMatchObject({ status: "pass", summary: "Canvas and audio randomized, voices blocked", slug: "fingerprint-protection" });
  });

  it("says the reads are steady when nothing is randomized", () => {
    expect(row({ canvas: entry(), webgl: entry() }).summary).toBe("Fingerprint reads are steady");
  });

  it("warns on a context mismatch", () => {
    const result = row({ canvas: entry({ classification: "context_inconsistent" }) }, [{ id: "fingerprint_context_inconsistent", severity: "medium", message: "m" }]);
    expect(result).toMatchObject({ status: "warn", summary: "Fingerprint differs between the page and a worker" });
  });

  it("is not available when the page did not measure stability", () => {
    expect(row(undefined)).toMatchObject({ status: "na", summary: "Fingerprint protection not measured" });
  });
});

describe("capture redaction", () => {
  it("keeps fingerprints.stability, which holds only counts and classes", () => {
    const stability = { canvas: entry({ classification: "randomized_session", controlAltered: true }) };
    const { fixture, redaction } = redactReport({
      server: { headers: chrome.headers },
      client: { fingerprints: { canvas: { supported: true, hash: "c4nv4s" }, stability } }
    });

    expect(fixture.client.fingerprints).toEqual({ canvas: { supported: true }, stability });
    expect(redaction.removedFields).toEqual(["client.fingerprints.canvas.hash"]);
  });
});
