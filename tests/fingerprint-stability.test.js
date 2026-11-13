import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifyStability, STABILITY_CLASSES, STABILITY_SURFACES } from "../public/fingerprint-stability.js";
import { validateFingerprintStability } from "../public/generated/validate-fingerprint-stability.js";
import { buildValidatorSource, VALIDATORS } from "../scripts/build-validators.mjs";

const schema = JSON.parse(readFileSync(new URL("../schemas/fingerprint-stability.schema.json", import.meta.url), "utf8"));

function entry(overrides = {}) {
  return { reads: 3, distinct: 1, workerMatch: true, iframeMatch: true, controlAltered: false, classification: "stable", ...overrides };
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
