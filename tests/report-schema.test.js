import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import { buildReportDownload, reportJson } from "../public/controls.js";
import { buildInteractionReport } from "../public/collect-interaction.js";
import { INTERACTION_CHECK_IDS } from "../public/interaction-checks.js";
import { REASON_IDS } from "../src/report-verdict.js";
import { HEADER_REASON_IDS } from "../src/server-signals.js";
import worker, { SCHEMA_VERSION } from "../src/worker.js";
import { humanLike } from "./fixtures/interaction-events.js";
import { automationControlReport, knownGoodBrowserReports } from "./e2e/fixtures/known-good-browsers.js";
import { createWorkerEnv } from "./worker-env.js";

const loadSchema = (name) => JSON.parse(readFileSync(new URL(`../schemas/${name}`, import.meta.url), "utf8"));
const reportSchema = loadSchema("report.schema.json");
const checkSchema = loadSchema("check.schema.json");
const ajv = new Ajv2020({ allErrors: true, strict: false });
for (const name of [
  "cloudflare-bot-management.schema.json",
  "interaction-report.schema.json",
  "fingerprint-stability.schema.json"
]) {
  ajv.addSchema(loadSchema(name));
}
ajv.addSchema(reportSchema);
const validateReport = ajv.compile(reportSchema);
const validateCheck = ajv.compile(checkSchema);

const browserHeaders = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-GB,en;q=0.9",
  "cf-connecting-ip": "203.0.113.44",
  "sec-ch-ua": '"Chromium";v="126"',
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
};

function explain(validate, body) {
  return validate(body) ? "" : ajv.errorsText(validate.errors, { separator: "\n" });
}

async function postReport(client, requestInit = {}) {
  const request = new Request("https://tells.example/api/report", {
    method: "POST",
    headers: { ...browserHeaders, "content-type": "application/json" },
    body: client === undefined ? "" : JSON.stringify(client)
  });
  if (requestInit.cf) Object.defineProperty(request, "cf", { value: requestInit.cf });
  const response = await worker.fetch(request, createWorkerEnv(), {});
  expect(response.status).toBe(200);
  return response.json();
}

describe("report and check schemas", () => {
  it("pins schema_version 1 to the same integer the Worker writes", () => {
    expect(SCHEMA_VERSION).toBe(1);
    expect(reportSchema.$defs.schemaVersion.const).toBe(SCHEMA_VERSION);
    expect(reportSchema.$id).toBe("https://tells.blowhorn.ai/schemas/v1/report.schema.json");
    expect(checkSchema.$id).toBe("https://tells.blowhorn.ai/schemas/v1/check.schema.json");
  });

  it("lists the reason ids the Worker can score, and no others", () => {
    expect(reportSchema.$defs.verdict.properties.reasons.items.properties.id.enum).toEqual([...REASON_IDS]);
    expect(reportSchema.$defs.server.properties.headerSignals.properties.reasons.items.properties.id.enum).toEqual([...HEADER_REASON_IDS]);
    expect(reportSchema.$defs.verdict.properties.reasons.items.properties.id.enum).toEqual(
      expect.arrayContaining([...INTERACTION_CHECK_IDS])
    );
  });

  it("validates a live GET /api/check body", async () => {
    const response = await worker.fetch(new Request("https://tells.example/api/check", {
      headers: browserHeaders
    }), createWorkerEnv(), {});
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(explain(validateCheck, body)).toBe("");
    expect(body.schema_version).toBe(SCHEMA_VERSION);
    expect(body.client).toBeUndefined();
    expect(body.detections).toBeUndefined();
  });

  it("validates a live POST /api/report, including an empty body and managed bot fields", async () => {
    const empty = await postReport(undefined);
    expect(explain(validateReport, empty)).toBe("");
    expect(empty.client).toBeNull();
    expect(empty.schema_version).toBe(SCHEMA_VERSION);

    const plain = await postReport({});
    expect(explain(validateReport, plain)).toBe("");
    expect(plain.client).toEqual({ consistency: {} });

    const interaction = buildInteractionReport(humanLike().events, humanLike().task);
    const pageClient = {
      ...knownGoodBrowserReports[0].client,
      interaction,
      fingerprints: automationControlReport.client.fingerprints
    };
    const full = await postReport(pageClient);
    expect(explain(validateReport, full)).toBe("");
    expect(full.client.interaction.schemaVersion).toBe(3);
    expect(full.client.fingerprints.stability.canvas.classification).toBeTypeOf("string");

    const managed = await postReport(pageClient, {
      cf: {
        country: "GB",
        clientTcpRtt: 20,
        botManagement: {
          score: 87,
          verifiedBot: false,
          signedAgent: false,
          staticResource: false,
          ja3Hash: "e7d705a3286e19ea42f587b344ee6865",
          ja4: "t13d1516h2_8daaf6152771_02713d6af862",
          detectionIds: [],
          jsDetection: { passed: true }
        }
      }
    });
    expect(explain(validateReport, managed)).toBe("");
    expect(managed.server.cloudflareBotManagement.available).toBe(true);
    expect(managed.detections.map((row) => row.name)).toEqual(expect.arrayContaining([
      "Managed bot score",
      "TLS fingerprint",
      "Interaction"
    ]));
  });

  it("puts schema_version in the download and the copy, because both serialize the response", async () => {
    const body = await postReport(knownGoodBrowserReports[0].client);
    expect(explain(validateReport, body)).toBe("");

    const file = buildReportDownload(body, new Date("2026-11-16T12:00:00.000Z"));
    const downloaded = JSON.parse(file.body);
    expect(explain(validateReport, downloaded)).toBe("");
    expect(downloaded.schema_version).toBe(SCHEMA_VERSION);
    expect(reportJson(body)).toBe(file.body);
  });

  it("rejects a response that drops schema_version or adds a field", async () => {
    const body = await postReport({});
    const { schema_version: _version, ...withoutVersion } = body;
    expect(validateReport(withoutVersion)).toBe(false);
    expect(validateReport({ ...body, extra: true })).toBe(false);
    expect(validateCheck(body)).toBe(false);
  });
});
