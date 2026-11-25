import { describe, expect, it } from "vitest";
import { SAMPLE_LABEL, buildInsights, shareCardSvg, windowStart } from "../src/insights.js";
import { placeInCrowd } from "../public/crowd.js";
import worker from "../src/worker.js";
import { persistReport } from "../src/report-catalog.js";
import { compactReports } from "../src/report-store.js";
import { createWorkerEnv } from "./worker-env.js";
import { createD1, createR2 } from "./d1-sqlite.js";

const NOW = new Date("2026-11-25T12:00:00Z");
const row = (dim, k, n, day = "2026-11-24") => ({ day, dim, k, n });
const rows = [
  row("total", "all", 100),
  row("class", "likely_human", 60), row("class", "suspicious", 25), row("class", "likely_bot", 15),
  row("score", "8", 60), row("score", "5", 25), row("score", "1", 15),
  row("reason", "ua_mismatch", 30), row("reason", "missing_accept", 20),
  row("pair", "missing_accept|ua_mismatch", 18),
  row("asn", "datacenter|likely_bot", 15), row("asn", "other|likely_human", 60), row("asn", "other|suspicious", 25),
  row("interaction", "likely_human|1", 50), row("interaction", "suspicious|1", 10),
  row("browser", "Chrome 126|macOS|likely_human", 40), row("browser", "HeadlessChrome|Linux|likely_bot", 15),
  row("browser", "Firefox 130|Windows|suspicious", 25), row("browser", "Safari 19|macOS|likely_human", 20),
  row("check", "Request profile|checked", 100), row("check", "Datacenter pattern|checked", 99),
  row("country", "GB", 40), row("country", "US", 30)
];

describe("buildInsights", () => {
  const out = buildInsights(rows, 30, NOW);

  it("labels every card with sample, window, date and the sample note", () => {
    expect(out.cards.length).toBeGreaterThanOrEqual(8);
    for (const card of out.cards) {
      expect(card.window_days).toBe(30);
      expect(card.as_of).toBe("2026-11-25");
      expect(card.sample).toBeGreaterThan(0);
      expect(card.quote).toContain("n = ");
      expect(card.quote).toContain("last 30 days");
      expect(card.quote).toContain(SAMPLE_LABEL);
    }
  });

  it("computes the figures from the aggregates", () => {
    const get = (id) => out.cards.find((c) => c.id === id);
    expect(get("reasons").data.reasons[0]).toEqual({ id: "ua_mismatch", runs: 30, share: 30 });
    expect(get("verdicts").headline).toContain("60%");
    expect(get("pairs").data.pairs[0]).toMatchObject({ a: "missing_accept", b: "ua_mismatch", runs: 18 });
    expect(get("datacenter").data.datacenter.find((d) => d.class === "likely_bot").share).toBe(100);
    expect(get("falsealarm").data).toMatchObject({ completed: 60, flagged: 10 });
    expect(get("falsealarm").quote).toContain("n = 60");
    expect(get("browsers").data.overall_flagged_share).toBe(40);
  });

  it("ranks standouts by excess over the overall rate, with no cut-off", () => {
    const standouts = out.cards.find((c) => c.id === "standouts").data.standouts;
    const headless = standouts.find((s) => s.cohort === "HeadlessChrome on Linux");
    expect(headless.excess).toBeGreaterThan(0);
    expect(standouts.find((s) => s.excess < 0)).toBeTruthy();
    const sizes = standouts.map((s) => Math.abs(s.excess));
    expect([...sizes].sort((a, b) => b - a)).toEqual(sizes);
  });

  it("returns an empty state without data", () => {
    expect(buildInsights([], 30, NOW)).toMatchObject({ empty: true, cards: [], sample: 0 });
  });

  it("starts a window on the right day", () => {
    expect(windowStart(NOW, 7)).toBe("2026-11-19");
  });

  it("renders an escaped share image", () => {
    const svg = shareCardSvg({ ...out.cards[0], headline: 'A <b>"quote"</b> & more' });
    expect(svg).toContain("&lt;b&gt;");
    expect(svg).not.toContain("<b>");
    expect(svg).toContain("#1E2117");
    expect(svg).toContain(SAMPLE_LABEL);
  });
});

describe("placeInCrowd", () => {
  it("places a score by the histogram", () => {
    const histogram = Array.from({ length: 10 }, (_, bucket) => ({ bucket, runs: bucket === 8 ? 60 : bucket === 5 ? 25 : bucket === 1 ? 15 : 0 }));
    expect(placeInCrowd(85, histogram)).toBe(70);
    expect(placeInCrowd(55, histogram)).toBe(28);
    expect(placeInCrowd(NaN, histogram)).toBeNull();
    expect(placeInCrowd(50, histogram.map((b) => ({ ...b, runs: 0 })))).toBeNull();
  });
});

describe("insights routes", () => {
  it("serves cards from stored aggregates and rejects other windows", async () => {
    const d1 = createD1();
    const env = createWorkerEnv({ REPORTS: d1, RAW: createR2() });
    const T0 = new Date();
    T0.setUTCMinutes(0, 0, 0);
    T0.setUTCHours(T0.getUTCHours() - 2);
    const body = { schema_version: 1, verdict: { score: 40, classification: "likely_bot", risk: "high", reasons: [{ id: "ua_mismatch", severity: "high", points: 30 }] }, server: { userAgent: "x", cf: { country: "gb" } }, client: {}, detections: [] };
    await persistReport(env, body, "3f1c2a84-5b6d-4e7f-8a9b-000000000001", T0);
    await compactReports(env, new Date());
    const get = (path) => worker.fetch(new Request(`https://t.example${path}`, { headers: { "cf-connecting-ip": "203.0.113.5" } }), env, {});
    const ok = await (await get("/api/insights?window=7")).json();
    expect(ok.enabled).toBe(true);
    expect(ok.sample).toBe(1);
    expect(ok.cards.find((c) => c.id === "reasons").data.reasons[0].id).toBe("ua_mismatch");
    expect((await get("/api/insights?window=5")).status).toBe(400);
    const svg = await get("/insights/card/reasons.svg?window=7");
    expect(svg.headers.get("content-type")).toContain("image/svg+xml");
    expect((await get("/insights/card/nope.svg?window=7")).status).toBe(404);
  });

  it("answers empty without storage", async () => {
    const response = await worker.fetch(new Request("https://t.example/api/insights?window=30"), createWorkerEnv(), {});
    expect(await response.json()).toMatchObject({ enabled: false, empty: true });
  });
});
