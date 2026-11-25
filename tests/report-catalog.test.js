import { describe, expect, it } from "vitest";
import worker from "../src/worker.js";
import {
  collectionOptedOut,
  forgetReport,
  persistReport,
  pruneReports,
  redactReport,
  uaFamily,
  validRunId
} from "../src/report-catalog.js";
import { createWorkerEnv } from "./worker-env.js";

const RUN = "3f1c2a84-5b6d-4e7f-8a9b-0c1d2e3f4a5b";
const chrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function fakeD1() {
  const calls = [];
  const rows = new Map();
  return {
    calls,
    rows,
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async run() {
              calls.push({ sql, values });
              if (sql.startsWith("INSERT OR IGNORE")) {
                if (!rows.has(values[0])) rows.set(values[0], values);
              } else if (sql.startsWith("DELETE FROM reports WHERE run_id")) {
                rows.delete(values[0]);
              }
              return { success: true };
            }
          };
        }
      };
    }
  };
}

const sample = {
  schema_version: 1,
  verdict: { score: 58, classification: "suspicious", risk: "medium", reasons: [{ id: "missing_accept", severity: "medium", points: 12, message: "free text" }] },
  server: {
    ip: "203.0.113.44",
    userAgent: chrome,
    headers: { cookie: "secret" },
    cf: { country: "gb" },
    datacenterHeuristic: { isLikelyDatacenter: true },
    ipIntel: { provider: "ipapi" }
  },
  client: { page: { url: "https://t.example/?token=1", referrer: "https://r.example/" }, interaction: { task: { completed: true } } },
  detections: [{ name: "Request profile", status: "checked", notes: "free text" }]
};

describe("redactReport", () => {
  it("keeps only the allow listed fields", () => {
    const row = redactReport(sample, RUN, new Date("2026-11-25T12:00:00Z"));
    expect(row).toMatchObject({
      run_id: RUN,
      received_day: "2026-11-25",
      expires_at: "2027-02-23T12:00:00.000Z",
      score: 58,
      classification: "suspicious",
      ua_family: "Chrome 126",
      os_family: "macOS",
      country: "GB",
      asn_class: "datacenter",
      interaction_completed: 1
    });
    const text = JSON.stringify(row);
    for (const secret of ["203.0.113.44", "cookie", "secret", "token=1", "r.example", "free text", "ipapi"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("names user agents by family", () => {
    expect(uaFamily("Mozilla/5.0 Firefox/130.0")).toBe("Firefox 130");
    expect(uaFamily("curl/8.0")).toBe("Other");
  });
});

describe("collection setting", () => {
  it("is on until the visitor opts out", () => {
    const req = (headers) => new Request("https://t.example/api/report", { method: "POST", headers });
    expect(collectionOptedOut(req({}))).toBe(false);
    expect(collectionOptedOut(req({ "x-tells-collect": "on" }))).toBe(false);
    expect(collectionOptedOut(req({ "x-tells-collect": "off" }))).toBe(true);
    expect(collectionOptedOut(req({ "sec-gpc": "1" }))).toBe(false);
  });

  it("accepts only uuid run ids", () => {
    expect(validRunId(RUN)).toBe(true);
    expect(validRunId("not-a-uuid")).toBe(false);
    expect(validRunId(null)).toBe(false);
  });
});

describe("storage", () => {
  it("does nothing without the REPORTS binding", async () => {
    expect(await persistReport({}, sample, RUN)).toBe(false);
  });

  it("writes one row per run id and never throws", async () => {
    const db = fakeD1();
    expect(await persistReport({ REPORTS: db }, sample, RUN)).toBe(true);
    expect(await persistReport({ REPORTS: db }, sample, RUN)).toBe(true);
    expect(db.rows.size).toBe(1);
    expect(await persistReport({ REPORTS: db }, sample, "bad")).toBe(false);
    const broken = { prepare() { throw new Error("down"); } };
    expect(await persistReport({ REPORTS: broken }, sample, RUN)).toBe(false);
  });

  it("forgets a run and prunes expired rows", async () => {
    const db = fakeD1();
    await persistReport({ REPORTS: db }, sample, RUN);
    expect(await forgetReport({ REPORTS: db }, RUN)).toBe(true);
    expect(db.rows.size).toBe(0);
    expect(await pruneReports({ REPORTS: db }, new Date("2026-11-25T00:00:00Z"))).toBe(true);
    expect(db.calls.at(-1).sql).toContain("expires_at <");
  });
});

describe("/api/report collection", () => {
  const post = (headers = {}) => new Request("https://t.example/api/report", {
    method: "POST",
    headers: { "cf-connecting-ip": "203.0.113.44", "user-agent": chrome, ...headers },
    body: JSON.stringify({ page: { url: "https://t.example/" } })
  });

  async function run(headers) {
    const db = fakeD1();
    const pending = [];
    const response = await worker.fetch(post(headers), createWorkerEnv({ REPORTS: db }), { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
    return { db, response };
  }

  it("keeps a redacted copy by default", async () => {
    const { db, response } = await run({ "x-tells-run": RUN });
    expect(response.status).toBe(200);
    expect(db.rows.has(RUN)).toBe(true);
  });

  it("keeps nothing when the visitor opted out", async () => {
    const { db, response } = await run({ "x-tells-run": RUN, "x-tells-collect": "off" });
    expect(response.status).toBe(200);
    expect(db.calls.length).toBe(0);
  });

  it("ignores Global Privacy Control", async () => {
    const { db } = await run({ "x-tells-run": RUN, "sec-gpc": "1" });
    expect(db.rows.has(RUN)).toBe(true);
  });

  it("still answers when storage fails", async () => {
    const broken = { prepare() { throw new Error("down"); } };
    const response = await worker.fetch(post({ "x-tells-run": RUN }), createWorkerEnv({ REPORTS: broken }), { waitUntil() {} });
    expect(response.status).toBe(200);
  });

  it("removes a run on forget", async () => {
    const db = fakeD1();
    const pending = [];
    const ctx = { waitUntil: (p) => pending.push(p) };
    const env = createWorkerEnv({ REPORTS: db });
    await worker.fetch(post({ "x-tells-run": RUN }), env, ctx);
    await Promise.all(pending);
    expect(db.rows.has(RUN)).toBe(true);
    const forget = await worker.fetch(new Request("https://t.example/api/report/forget", {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.44" },
      body: JSON.stringify({ run_id: RUN })
    }), env, ctx);
    expect(forget.status).toBe(200);
    expect(db.rows.has(RUN)).toBe(false);
  });
});
