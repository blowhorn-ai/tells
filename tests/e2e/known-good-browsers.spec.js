import { expect, test } from "@playwright/test";
import { capturedAutomationReports, capturedHumanReports } from "./fixtures/captured-reports.js";
import {
  automationControlReport,
  disallowedKnownGoodReasonIds,
  knownGoodBrowserReports
} from "./fixtures/known-good-browsers.js";

test.describe("known-good browser detection", () => {
  for (const browserReport of knownGoodBrowserReports) {
    test(`${browserReport.name} stays low-risk`, async ({ request }) => {
      const body = await postReport(request, browserReport.headers, browserReport.client);

      expect(body.ok).toBe(true);
      expect(body.verdict).toMatchObject({
        classification: "likely_human",
        risk: "low"
      });
      expect(body.verdict.score).toBeGreaterThanOrEqual(90);
      expect(body.verdict.reasons.filter((reason) => reason.severity !== "low")).toEqual([]);
      expect(reasonIds(body).filter((id) => disallowedKnownGoodReasonIds.includes(id))).toEqual([]);
      expect(body.client.browser.webdriver).toBe(false);
      expect(body.client.automation.present).toEqual([]);
    });
  }

  test("good browser request headers are enough for server-only checks", async ({ request }) => {
    for (const browserReport of knownGoodBrowserReports) {
      const response = await request.get("/api/check", {
        headers: browserReport.headers
      });
      const body = await response.json();

      expect(response.ok(), browserReport.name).toBe(true);
      expect(body.verdict.classification, browserReport.name).toBe("likely_human");
      expect(body.verdict.risk, browserReport.name).toBe("low");
      expect(reasonIds(body), browserReport.name).not.toContain("automation_user_agent");
    }
  });

  test("automation control still trips bot-specific reasons", async ({ request }) => {
    const body = await postReport(request, automationControlReport.headers, automationControlReport.client);
    const reasons = reasonIds(body);

    expect(body.ok).toBe(true);
    expect(body.verdict.classification).toBe("likely_bot");
    expect(body.verdict.risk).toBe("high");
    expect(reasons).toEqual(expect.arrayContaining([
      "automation_user_agent",
      "client_headless_user_agent",
      "navigator_webdriver",
      "automation_globals",
      "cdp_serialization_signal",
      "behavior_score_low",
      "webdriver_own_property",
      "native_function_patched",
      "document_automation_keys",
      "synthetic_input",
      "input_while_hidden",
      "fingerprint_context_inconsistent"
    ]));
  });
});

// Real, redacted reports from tests/e2e/fixtures/captures (scripts/capture-fixture.mjs).
test.describe("captured known-good corpus", () => {
  for (const capture of capturedHumanReports) {
    test(`${capture.name} stays likely_human`, async ({ request }) => {
      const body = await postReport(request, capture.headers, capture.client);

      expect(body.verdict.classification).toBe("likely_human");
      expect(reasonIds(body).filter((id) => disallowedKnownGoodReasonIds.includes(id))).toEqual([]);
    });
  }

  // Release gate: a privacy browser randomizes or blocks a surface but never disagrees between contexts.
  for (const capture of capturedHumanReports.filter((report) => report.privacySettings.length && report.client.fingerprints?.stability)) {
    test(`${capture.name} shows its fingerprint protection`, async ({ request }) => {
      const body = await postReport(request, capture.headers, capture.client);
      const classes = Object.values(body.client.fingerprints.stability).map((surface) => surface.classification);

      expect(classes).not.toContain("context_inconsistent");
      expect(classes.some((value) => ["randomized_session", "randomized_per_read", "blocked"].includes(value))).toBe(true);
      expect(body.verdict.classification).toBe("likely_human");
    });
  }

  for (const capture of capturedAutomationReports) {
    test(`${capture.name} is caught`, async ({ request }) => {
      const body = await postReport(request, capture.headers, capture.client);

      expect(body.verdict.classification).toBe("likely_bot");
    });
  }
});

async function postReport(request, headers, client) {
  const response = await request.post("/api/report", {
    headers,
    data: client
  });
  const body = await response.json();

  expect(response.ok()).toBe(true);
  return body;
}

function reasonIds(body) {
  return body.verdict.reasons.map((reason) => reason.id);
}
