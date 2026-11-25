import { describe, expect, it } from "vitest";
import { gunzipSync } from "node:zlib";
import worker from "../src/worker.js";
import { persistReport, forgetReport, currentMode } from "../src/report-catalog.js";
import { BUDGET, computeMode, keepRaw, retentionDays } from "../src/report-budget.js";
import { aggregateRow, collectionStats, compactReports, pruneReports } from "../src/report-store.js";
import { createWorkerEnv } from "./worker-env.js";
import { createD1, createR2 } from "./d1-sqlite.js";

const chrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const T0 = new Date("2026-11-25T10:30:00Z");
const T1 = new Date("2026-11-25T11:05:00Z");
const uuid = (n) => `3f1c2a84-5b6d-4e7f-8a9b-${String(n).padStart(12, "0")}`;

function report(overrides = {}) {
  return {
    schema_version: 1,
    verdict: {
      score: 58, classification: "suspicious", risk: "medium",
      reasons: [{ id: "missing_accept", severity: "medium", points: 12 }, { id: "ua_mismatch", severity: "high", points: 30 }]
    },
    server: { userAgent: chrome, cf: { country: "gb" }, datacenterHeuristic: { isLikelyDatacenter: true } },
    client: { interaction: { task: { completed: false } } },
    detections: [{ name: "Request profile", status: "checked" }],
    ...overrides
  };
}

function setup(extra = {}) {
  const d1 = createD1();
  const r2 = createR2();
  return { d1, r2, env: createWorkerEnv({ REPORTS: d1, RAW: r2, ...extra }) };
}

describe("budget modes", () => {
  const usage = (over = {}) => ({ disabled: false, ledgerOk: true, day: { accepted: 0, d1_writes: 0 }, rawBytes: 0, monthClassA: 0, ...over });

  it("picks a mode from the highest budget ratio", () => {
    expect(computeMode(usage())).toBe("normal");
    expect(computeMode(usage({ day: { accepted: 0.6 * BUDGET.dailyReports, d1_writes: 0 } }))).toBe("tighten");
    expect(computeMode(usage({ rawBytes: 0.75 * BUDGET.rawBytes }))).toBe("sample");
    expect(computeMode(usage({ day: { accepted: 0, d1_writes: 0.9 * BUDGET.dailyD1Writes } }))).toBe("aggregate");
    expect(computeMode(usage({ monthClassA: 0.96 * BUDGET.monthlyClassA }))).toBe("count");
    expect(computeMode(usage({ rawBytes: BUDGET.rawBytes }))).toBe("off");
  });

  it("fails closed when disabled, unreadable or malformed", () => {
    expect(computeMode(usage({ disabled: true }))).toBe("off");
    expect(computeMode(usage({ ledgerOk: false }))).toBe("off");
    expect(computeMode(null)).toBe("off");
    expect(computeMode(usage({ day: { accepted: Number.NaN } }))).toBe("off");
  });

  it("shortens retention and samples raw as the budget fills", () => {
    expect(retentionDays("normal")).toBe(90);
    expect(retentionDays("tighten")).toBeLessThan(90);
    expect(keepRaw("normal", uuid(1), 0)).toBe(true);
    expect(keepRaw("aggregate", uuid(1), 5)).toBe(false);
    expect(keepRaw("sample", uuid(1), 3)).toBe(true);
  });
});

describe("ingest", () => {
  it("stores one row per run and counts it once", async () => {
    const { env, d1 } = setup();
    expect(await persistReport(env, report(), uuid(1), T0)).toBe("stored");
    expect(await persistReport(env, report(), uuid(1), T0)).toBe("stored");
    expect(d1.db.prepare("SELECT COUNT(*) n FROM reports").get().n).toBe(1);
    expect(d1.db.prepare("SELECT SUM(accepted) n FROM ledger").get().n).toBe(1);
  });

  it("writes nothing when the kill switch is set or the ledger is unreadable", async () => {
    const off = setup({ COLLECT_DISABLED: "1" });
    expect(await persistReport(off.env, report(), uuid(1), T0)).toBe(false);
    expect(off.d1.db.prepare("SELECT COUNT(*) n FROM reports").get().n).toBe(0);
    const broken = setup();
    broken.d1.stats.failNext = true;
    expect(await persistReport(broken.env, report(), uuid(1), T0)).toBe(false);
  });

  it("only counts once the daily report budget is nearly full, and stops at the budget", async () => {
    const { env, d1 } = setup();
    d1.db.prepare("INSERT INTO ledger (period, accepted) VALUES ('2026-11-25', ?)").run(Math.ceil(0.96 * BUDGET.dailyReports));
    expect(await currentMode(env, T0)).toBe("count");
    expect(await persistReport(env, report(), uuid(2), T0)).toBe("counted");
    expect(d1.db.prepare("SELECT COUNT(*) n FROM reports").get().n).toBe(0);
    d1.db.prepare("UPDATE ledger SET accepted = ?").run(BUDGET.dailyReports);
    expect(await persistReport(env, report(), uuid(3), T0)).toBe(false);
  });

  it("works without the bindings", async () => {
    expect(await persistReport(createWorkerEnv(), report(), uuid(1), T0)).toBe(false);
  });
});

describe("compaction", () => {
  it("aggregates waiting rows and writes one gzipped object per hour", async () => {
    const { env, d1, r2 } = setup();
    for (let i = 1; i <= 5; i += 1) await persistReport(env, report(), uuid(i), T0);
    const result = await compactReports(env, T1);
    expect(result).toMatchObject({ mode: "normal", compacted: 5, objects: 1 });
    expect(r2.calls.put).toBe(1);
    expect(r2.calls.list).toBe(0);
    const [[key, body]] = [...r2.objects];
    expect(key).toMatch(/^reports\/2026\/11\/25\/10-\d+\.ndjson\.gz$/);
    const lines = gunzipSync(Buffer.from(body)).toString().trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(5);
    expect(JSON.stringify(lines)).not.toContain("203.0.113");
    const agg = (dim, k) => d1.db.prepare("SELECT n FROM agg_counts WHERE dim = ? AND k = ?").get(dim, k)?.n;
    expect(agg("total", "all")).toBe(5);
    expect(agg("reason", "ua_mismatch")).toBe(5);
    expect(agg("pair", "missing_accept|ua_mismatch")).toBe(5);
    expect(agg("country", "GB")).toBe(5);
    expect(d1.db.prepare("SELECT COUNT(*) n FROM reports WHERE state = 0").get().n).toBe(0);
    expect(d1.db.prepare("SELECT v FROM state WHERE k = 'raw_held_bytes'").get().v).toBeGreaterThan(0);
    // A second run has nothing to do and makes no R2 call.
    expect((await compactReports(env, T1)).compacted).toBe(0);
    expect(r2.calls.put).toBe(1);
  });

  it("does not touch the current hour", async () => {
    const { env } = setup();
    await persistReport(env, report(), uuid(1), new Date("2026-11-25T11:10:00Z"));
    expect((await compactReports(env, T1)).compacted).toBe(0);
  });

  it("aggregates but writes no raw object in aggregate mode", async () => {
    const { env, d1, r2 } = setup();
    for (let i = 1; i <= 3; i += 1) await persistReport(env, report(), uuid(i), T0);
    d1.db.prepare("UPDATE ledger SET d1_writes = ?").run(0.9 * BUDGET.dailyD1Writes);
    const result = await compactReports(env, T1);
    expect(result).toMatchObject({ mode: "aggregate", compacted: 3, objects: 0 });
    expect(r2.calls.put).toBe(0);
    expect(d1.db.prepare("SELECT n FROM agg_counts WHERE dim = 'total'").get().n).toBe(3);
  });

  it("marks nothing when the R2 put fails, and retries under the same key", async () => {
    const { env, d1, r2 } = setup();
    await persistReport(env, report(), uuid(1), T0);
    const put = r2.put;
    r2.put = async () => { throw new Error("R2 down"); };
    await expect(compactReports(env, T1)).rejects.toThrow();
    expect(d1.db.prepare("SELECT COUNT(*) n FROM reports WHERE state = 0").get().n).toBe(1);
    r2.put = put;
    expect((await compactReports(env, T1)).compacted).toBe(1);
  });

  it("does nothing in off mode", async () => {
    const { env, r2 } = setup({ COLLECT_DISABLED: "1" });
    expect((await compactReports(env, T1)).mode).toBe("off");
    expect(r2.calls.put).toBe(0);
  });

  it("never issues more than one put per hour that has data, whatever the volume", async () => {
    const { env, r2 } = setup();
    for (let i = 1; i <= 200; i += 1) await persistReport(env, report(), uuid(i), T0);
    await compactReports(env, T1);
    expect(r2.calls.put).toBe(1);
  });

  it("aggregates a row from fixed shapes only", () => {
    const seen = [];
    aggregateRow({ received_day: "2026-11-25", classification: "x", reasons: "not json", detections: "[]", score: 101 }, (...a) => seen.push(a.join(":")));
    expect(seen).toContain("2026-11-25:score:9");
  });
});

describe("prune and total", () => {
  it("deletes expired rows and objects, keeps aggregates and the total", async () => {
    const { env, d1, r2 } = setup();
    await persistReport(env, report(), uuid(1), T0);
    await compactReports(env, T1);
    const later = new Date("2027-03-01T03:17:00Z");
    expect(await pruneReports(env, later)).toBe(true);
    expect(d1.db.prepare("SELECT COUNT(*) n FROM reports").get().n).toBe(0);
    expect(d1.db.prepare("SELECT COUNT(*) n FROM raw_objects").get().n).toBe(0);
    expect(r2.objects.size).toBe(0);
    expect(r2.calls.list).toBe(0);
    expect(d1.db.prepare("SELECT v FROM state WHERE k = 'raw_held_bytes'").get().v).toBe(0);
    expect(d1.db.prepare("SELECT n FROM agg_counts WHERE dim = 'total'").get().n).toBe(1);
    const stats = await collectionStats(env, later);
    expect(stats).toMatchObject({ enabled: true, total_collected: 1, held_now: 0, since: "2026-11-25" });
  });

  it("never deletes rows that are not aggregated yet", async () => {
    const { env, d1 } = setup();
    await persistReport(env, report(), uuid(1), T0);
    await pruneReports(env, new Date("2027-03-01T03:17:00Z"));
    expect(d1.db.prepare("SELECT COUNT(*) n FROM reports").get().n).toBe(1);
  });

  it("keeps the total when a visitor removes a run, and counts the removal", async () => {
    const { env } = setup();
    await persistReport(env, report(), uuid(1), T0);
    await forgetReport(env, uuid(1), T0);
    expect(await collectionStats(env, T0)).toMatchObject({ total_collected: 1, removed_on_request: 1, held_now: 0 });
  });
});

describe("/api/stats and the Worker", () => {
  it("reports the total collected", async () => {
    const { env } = setup();
    await persistReport(env, report(), uuid(1), T0);
    const response = await worker.fetch(new Request("https://t.example/api/stats", { headers: { "cf-connecting-ip": "203.0.113.9" } }), env, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ enabled: true, total_collected: 1 });
  });

  it("reports disabled without storage", async () => {
    const response = await worker.fetch(new Request("https://t.example/api/stats"), createWorkerEnv(), {});
    expect((await response.json()).enabled).toBe(false);
  });

  it("scheduled runs the hourly job and prunes only at 03 UTC", async () => {
    const { env, r2 } = setup();
    await persistReport(env, report(), uuid(1), T0);
    await worker.scheduled({ scheduledTime: T1.getTime() }, env, { waitUntil() {} });
    expect(r2.calls.put).toBe(1);
    expect(r2.calls.delete).toBe(0);
  });
});

describe("wrangler.json spend guard", () => {
  it("allows only the free bindings", async () => {
    const { readFileSync } = await import("node:fs");
    const config = JSON.parse(readFileSync(new URL("../wrangler.json", import.meta.url), "utf8"));
    const allowed = new Set(["$schema", "name", "main", "compatibility_date", "routes", "workers_dev", "preview_urls",
      "placement", "assets", "ratelimits", "vars", "triggers", "observability", "d1_databases", "r2_buckets"]);
    for (const key of Object.keys(config)) expect(allowed.has(key), `unexpected wrangler.json key: ${key}`).toBe(true);
    for (const d1 of config.d1_databases ?? []) expect(d1.binding).toBe("REPORTS");
    for (const r2 of config.r2_buckets ?? []) expect(r2.binding).toBe("RAW");
    expect(JSON.stringify(config)).not.toMatch(/durable|queues|logpush|REPLACE/i);
  });
});
