import { describe, expect, it } from "vitest";
import worker from "../src/worker.js";
import {
  collectionOptedOut,
  redactReport,
  uaFamily,
  validRunId
} from "../src/report-catalog.js";
import { createWorkerEnv } from "./worker-env.js";
import { createD1, createR2 } from "./d1-sqlite.js";

const RUN = "3f1c2a84-5b6d-4e7f-8a9b-0c1d2e3f4a5b";
const chrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

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

describe("/api/report collection", () => {
  const post = (headers = {}) => new Request("https://t.example/api/report", {
    method: "POST",
    headers: { "cf-connecting-ip": "203.0.113.44", "user-agent": chrome, ...headers },
    body: JSON.stringify({ page: { url: "https://t.example/" } })
  });

  async function run(headers, extra = {}) {
    const d1 = createD1();
    const pending = [];
    const response = await worker.fetch(post(headers), createWorkerEnv({ REPORTS: d1, RAW: createR2(), ...extra }), { waitUntil: (p) => pending.push(p) });
    await Promise.all(pending);
    return { d1, response, count: d1.db.prepare("SELECT COUNT(*) n FROM reports").get().n };
  }

  it("keeps a redacted copy by default", async () => {
    const { response, count, d1 } = await run({ "x-tells-run": RUN });
    expect(response.status).toBe(200);
    expect(count).toBe(1);
    expect(JSON.stringify(d1.db.prepare("SELECT * FROM reports").all())).not.toContain("203.0.113.44");
  });

  it("keeps nothing when the visitor opted out", async () => {
    const { response, count } = await run({ "x-tells-run": RUN, "x-tells-collect": "off" });
    expect(response.status).toBe(200);
    expect(count).toBe(0);
  });

  it("ignores Global Privacy Control", async () => {
    expect((await run({ "x-tells-run": RUN, "sec-gpc": "1" })).count).toBe(1);
  });

  it("keeps nothing for a run without a valid run id", async () => {
    expect((await run({})).count).toBe(0);
  });

  it("keeps nothing when the kill switch is set", async () => {
    expect((await run({ "x-tells-run": RUN }, { COLLECT_DISABLED: "1" })).count).toBe(0);
  });

  it("still answers when storage fails", async () => {
    const d1 = createD1();
    d1.stats.failNext = true;
    const response = await worker.fetch(post({ "x-tells-run": RUN }), createWorkerEnv({ REPORTS: d1 }), { waitUntil() {} });
    expect(response.status).toBe(200);
  });

  it("removes a run on forget", async () => {
    const d1 = createD1();
    const pending = [];
    const ctx = { waitUntil: (p) => pending.push(p) };
    const env = createWorkerEnv({ REPORTS: d1 });
    await worker.fetch(post({ "x-tells-run": RUN }), env, ctx);
    await Promise.all(pending);
    const forget = await worker.fetch(new Request("https://t.example/api/report/forget", {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.44" },
      body: JSON.stringify({ run_id: RUN })
    }), env, ctx);
    expect(forget.status).toBe(200);
    expect(d1.db.prepare("SELECT COUNT(*) n FROM reports").get().n).toBe(0);
  });
});
