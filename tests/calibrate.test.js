import { describe, expect, it } from "vitest";
import { evaluate, parseNdjson, wilson } from "../scripts/calibrate.mjs";

const botReport = { server: { userAgent: "Mozilla/5.0 HeadlessChrome/120" }, client: { browser: { webdriver: true, userAgent: "Mozilla/5.0 HeadlessChrome/120" } } };
const humanReport = { server: { userAgent: "Mozilla/5.0 Chrome/120" } };

describe("calibrate script", () => {
  it("computes recall and false alarms with intervals", () => {
    const rows = [
      { label: "bot", source: "playwright", report: botReport },
      { label: "bot", source: "playwright", report: botReport },
      { label: "human", source: "stock-chrome", report: humanReport }
    ];
    const result = evaluate(rows);
    expect(result.bots).toBe(2);
    expect(result.bot_recall).toBe(1);
    expect(result.sweep.length).toBeGreaterThan(5);
    expect(result.by_source["playwright (bot)"]).toEqual({ runs: 2, flagged: 2 });
    expect(result.bot_recall_ci.low).toBeLessThan(1);
  });
  it("rejects a line without a valid label", () => {
    expect(() => parseNdjson('{"label":"maybe","report":{}}')).toThrow(/label/);
    expect(() => parseNdjson('{"label":"bot"}')).toThrow(/report/);
  });
  it("gives a wide interval for a tiny sample", () => {
    const { low, high } = wilson(1, 2);
    expect(high - low).toBeGreaterThan(0.5);
  });
});
