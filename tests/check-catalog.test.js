import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import { summarizePointerMoves } from "../public/behavior-score.js";
import { CHECKS } from "../public/checks-view-model.js";
import { INTERACTION_CHECK_IDS } from "../public/interaction-checks.js";
import { REASON_IDS, scoreInteraction, scoreReport } from "../src/report-verdict.js";
import { collectServer } from "../src/server-signals.js";

const catalog = JSON.parse(readFileSync(new URL("../schemas/check-catalog.json", import.meta.url), "utf8"));
const schema = JSON.parse(readFileSync(new URL("../schemas/check-catalog.schema.json", import.meta.url), "utf8"));
const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

const DESKTOP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function behaviorFrom(events, elapsedMs, rafStdDev = 0) {
  const eventCounts = {};
  for (const event of events) eventCounts[event.type] = (eventCounts[event.type] || 0) + 1;
  const pointer = summarizePointerMoves(events);
  return {
    summary: {
      elapsedMs,
      eventCounts,
      pointerMoveSamples: pointer.pointerMoveSamples,
      pointerDistance: pointer.pointerDistance,
      pointerSpeedStdDev: pointer.pointerSpeedStdDev,
      rafStdDev
    },
    recentEvents: events
  };
}

const humanEvents = [
  { type: "pointermove", t: 0, x: 0, y: 0 },
  { type: "pointermove", t: 40, x: 90, y: 10 },
  { type: "pointermove", t: 90, x: 90, y: 70 },
  { type: "pointermove", t: 160, x: 160, y: 70 },
  { type: "pointermove", t: 260, x: 150, y: 140 },
  { type: "pointerdown", t: 300, x: 150, y: 140 },
  { type: "click", t: 340, x: 150, y: 140 },
  { type: "keydown", t: 400 },
  { type: "scroll", t: 480 }
];

function quietClient(patch = {}) {
  const browser = {
    userAgent: DESKTOP_UA,
    webdriver: false,
    plugins: [{ name: "PDF Viewer" }],
    languages: ["en-US"],
    timezone: "Etc/UTC",
    userAgentData: { platform: "macOS", mobile: false },
    maxTouchPoints: 0,
    features: { touchEvent: false },
    screen: { width: 1440, height: 900, innerWidth: 1200, innerHeight: 800, outerWidth: 1440, outerHeight: 900 },
    permissions: { notifications: { state: "prompt", permission: "default" } },
    ...patch.browser
  };
  return {
    browser,
    behavior: behaviorFrom(humanEvents, 5000, 0.4),
    ...patch,
    browser
  };
}

function score(server = {}, client = undefined) {
  return scoreReport({ server: { userAgent: DESKTOP_UA, ...server }, client });
}

function reason(server, client, id) {
  return score(server, client).reasons.find((item) => item.id === id);
}

function stability(overrides) {
  return { reads: 3, distinct: 1, workerMatch: true, iframeMatch: true, controlAltered: false, classification: "stable", ...overrides };
}

const headerCases = {
  missing_user_agent: {},
  automation_user_agent: { "user-agent": "Mozilla/5.0 HeadlessChrome/126.0.0.0", accept: "*/*", "accept-language": "en" },
  library_user_agent: { "user-agent": "curl/8.0.0", accept: "*/*", "accept-language": "en" },
  missing_accept: { "user-agent": DESKTOP_UA, "accept-language": "en", "sec-ch-ua": "\"Chromium\";v=\"126\"" },
  missing_accept_language: { "user-agent": DESKTOP_UA, accept: "*/*", "sec-ch-ua": "\"Chromium\";v=\"126\"" },
  missing_client_hints: { "user-agent": DESKTOP_UA, accept: "*/*", "accept-language": "en" },
  body_without_content_type: { "user-agent": DESKTOP_UA, accept: "*/*", "accept-language": "en", "sec-ch-ua": "\"Chromium\";v=\"126\"", "content-length": "12" }
};

async function scoredHeader(id) {
  const server = await collectServer(new Request("https://tells.example/api/check", { headers: headerCases[id] }), { IP_INTEL_PROVIDER: "none" });
  return scoreReport({ server }).reasons.find((item) => item.id === id);
}

// Each scored reason is produced by the Worker, not by a copied points table.
const triggers = {
  server_missing_ua: () => reason({ userAgent: "" }, undefined, "server_missing_ua"),
  proxy_headers: () => reason({ proxyHeaders: { via: "1.1 proxy.example" } }, undefined, "proxy_headers"),
  datacenter_asn_heuristic: () => reason({ datacenterHeuristic: { isLikelyDatacenter: true, organization: "Example Hosting" } }, undefined, "datacenter_asn_heuristic"),
  ip_vpn: () => reason({ ipIntel: { normalized: { isVpn: true } } }, undefined, "ip_vpn"),
  ip_proxy: () => reason({ ipIntel: { normalized: { isProxy: true } } }, undefined, "ip_proxy"),
  ip_tor: () => reason({ ipIntel: { normalized: { isTor: true } } }, undefined, "ip_tor"),
  ip_datacenter: () => reason({ ipIntel: { normalized: { isDatacenter: true } } }, undefined, "ip_datacenter"),
  ip_crawler: () => reason({ ipIntel: { normalized: { isCrawler: true } } }, undefined, "ip_crawler"),
  ip_abuser: () => reason({ ipIntel: { normalized: { isAbuser: true } } }, undefined, "ip_abuser"),
  ipqs_high_fraud_score: () => reason({ ipIntel: { normalized: { fraudScore: 90 } } }, undefined, "ipqs_high_fraud_score"),
  managed_bot_score_low: () => reason({ cloudflareBotManagement: { available: true, score: 10, verifiedBot: false } }, undefined, "managed_bot_score_low"),
  managed_bot_score_borderline: () => reason({ cloudflareBotManagement: { available: true, score: 40, verifiedBot: false } }, undefined, "managed_bot_score_borderline"),
  cloudflare_verified_bot: () => reason({ cloudflareBotManagement: { available: true, score: 90, verifiedBot: true } }, undefined, "cloudflare_verified_bot"),
  navigator_webdriver: () => reason({}, quietClient({ browser: { webdriver: true } }), "navigator_webdriver"),
  client_headless_user_agent: () => reason({}, quietClient({ browser: { userAgent: "Mozilla/5.0 HeadlessChrome/126.0.0.0" } }), "client_headless_user_agent"),
  empty_plugins_chromium: () => reason({}, quietClient({ browser: { plugins: [] } }), "empty_plugins_chromium"),
  plugin_reference_mismatch: () => reason({}, quietClient({ browser: { pluginsConsistency: { referenceMismatch: true } } }), "plugin_reference_mismatch"),
  plugin_item_overflow: () => reason({}, quietClient({ browser: { pluginsConsistency: { itemOverflowMatchesFirst: false } } }), "plugin_item_overflow"),
  prototype_getter_not_native: () => reason({}, quietClient({ browser: { prototypeChecks: { nativeGetterFailures: ["languages"] } } }), "prototype_getter_not_native"),
  screen_viewport_impossible: () => reason({}, quietClient({ consistency: { screenViewportImpossible: { innerWidth: 2000 } } }), "screen_viewport_impossible"),
  mobile_touch_mismatch: () => reason({}, quietClient({ consistency: { mobileTouchMismatch: { maxTouchPoints: 0 } } }), "mobile_touch_mismatch"),
  notification_permission_default_state: () => reason({}, quietClient({ browser: { permissions: { notifications: { state: "default", permission: "default" } } } }), "notification_permission_default_state"),
  notification_permission_contradiction: () => reason({}, quietClient({ browser: { permissions: { notifications: { state: "prompt", permission: "denied" } } } }), "notification_permission_contradiction"),
  webgl_missing: () => reason({}, quietClient({ fingerprints: { webgl: { supported: false } } }), "webgl_missing"),
  canvas_error: () => reason({}, quietClient({ fingerprints: { canvas: { error: "blocked" } } }), "canvas_error"),
  fingerprint_context_inconsistent: () => reason({}, quietClient({ fingerprints: { stability: { canvas: stability({ workerMatch: false }) } } }), "fingerprint_context_inconsistent"),
  fingerprint_randomized: () => reason({}, quietClient({ fingerprints: { stability: { canvas: stability({ distinct: 3 }) } } }), "fingerprint_randomized"),
  performance_memory_anomaly: () => reason({}, quietClient({
    network: { ping: { memorySamples: [{ supported: true, t: 1, usedJSHeapSize: 20, totalJSHeapSize: 10, jsHeapSizeLimit: 256 * 1024 * 1024, usedRatio: 0.5 }] } }
  }), "performance_memory_anomaly"),
  worker_platform_mismatch: () => reason({}, quietClient({ consistency: { workerPlatformMismatch: { window: "MacIntel", worker: "Linux" } } }), "worker_platform_mismatch"),
  iframe_platform_mismatch: () => reason({}, quietClient({ consistency: { iframePlatformMismatch: { window: "MacIntel", iframe: "Linux" } } }), "iframe_platform_mismatch"),
  webrtc_public_ip_mismatch: () => reason({}, quietClient({ network: { webrtc: { publicIpLeakDifferentFromServer: true } } }), "webrtc_public_ip_mismatch"),
  browser_edge_latency_gap: () => reason({ cf: { clientTcpRtt: 20 } }, quietClient({ network: { ping: { medianMs: 400 } } }), "browser_edge_latency_gap"),
  automation_globals: () => reason({}, quietClient({ automation: { present: ["__playwright"] } }), "automation_globals"),
  document_automation_keys: () => reason({}, quietClient({ tells: { documentAutomationKeys: ["$cdc_asdjflasutopfhvcZLmcfl_"] } }), "document_automation_keys"),
  cdp_serialization_signal: () => reason({}, quietClient({ automation: { cdpSerializationSignal: true } }), "cdp_serialization_signal"),
  webdriver_own_property: () => reason({}, quietClient({ tells: { webdriver: { definedOn: "navigator" } } }), "webdriver_own_property"),
  webdriver_getter_patched: () => reason({}, quietClient({ tells: { webdriver: { getterNative: false, definedOn: "prototype" } } }), "webdriver_getter_patched"),
  native_function_patched: () => reason({}, quietClient({ tells: { nativeFunctions: { functionToString: false } } }), "native_function_patched"),
  prototype_lie_mismatch: () => reason({}, quietClient({
    tells: {
      prototypeLies: {
        page: { functionToString: true, getters: { webdriver: true, languages: true, plugins: true } },
        iframe: { functionToString: false, getters: { webdriver: true, languages: true, plugins: true } },
        worker: { functionToString: true, getters: { webdriver: true, languages: true, plugins: null } }
      }
    }
  }), "prototype_lie_mismatch"),
  synthetic_input: () => reason({}, quietClient({ tells: { input: { untrusted: 2 } } }), "synthetic_input"),
  input_while_hidden: () => reason({}, quietClient({ tells: { input: { trustedWhileHidden: 1 } } }), "input_while_hidden"),
  input_without_focus: () => reason({}, quietClient({ tells: { input: { trustedWithoutFocus: 1 } } }), "input_without_focus"),
  zero_size_window: () => reason({}, quietClient({ browser: { screen: { innerWidth: 800, outerWidth: 0, outerHeight: 0 } } }), "zero_size_window"),
  request_client_ua_mismatch: () => reason({}, quietClient({ consistency: { userAgentMismatch: { requestUserAgent: "a", browserUserAgent: "b" } } }), "request_client_ua_mismatch"),
  accept_language_mismatch: () => reason({}, quietClient({ consistency: { acceptLanguageMismatch: { requestLanguages: ["de"], browserLanguages: ["en"] } } }), "accept_language_mismatch"),
  client_hint_platform_mismatch: () => reason({}, quietClient({ consistency: { clientHintPlatformMismatch: { requestPlatform: "Windows", browserPlatform: "macOS" } } }), "client_hint_platform_mismatch"),
  client_hint_mobile_mismatch: () => reason({}, quietClient({ consistency: { clientHintMobileMismatch: { requestMobile: false, browserMobile: true } } }), "client_hint_mobile_mismatch"),
  client_hint_high_entropy_mismatch: () => reason({}, quietClient({ consistency: { clientHintHighEntropyMismatch: { mismatches: ["platform"] } } }), "client_hint_high_entropy_mismatch"),
  ua_data_high_entropy_mismatch: () => reason({}, quietClient({ consistency: { userAgentDataHighEntropyMismatch: { platform: ["macOS", "Linux"] } } }), "ua_data_high_entropy_mismatch"),
  ua_platform_mismatch: () => reason({}, quietClient({ consistency: { uaPlatformMismatch: { userAgent: "Mac", platform: "Linux" } } }), "ua_platform_mismatch"),
  timezone_mismatch: () => reason({}, quietClient({ consistency: { timezoneMismatch: { browserTimezone: "UTC", ipTimezone: "America/Chicago" } } }), "timezone_mismatch"),
  behavior_score_low: () => reason({}, quietClient({ behavior: behaviorFrom([], 100) }), "behavior_score_low"),
  behavior_no_input: () => reason({}, quietClient({ behavior: behaviorFrom([], 5000) }), "behavior_no_input"),
  behavior_score_borderline: () => reason({}, quietClient({
    behavior: behaviorFrom([
      { type: "pointermove", t: 0, x: 0, y: 0 },
      { type: "pointermove", t: 100, x: 10, y: 0 },
      { type: "pointermove", t: 200, x: 20, y: 0 },
      { type: "pointermove", t: 300, x: 30, y: 0 },
      { type: "pointermove", t: 400, x: 40, y: 0 }
    ], 2000)
  }), "behavior_score_borderline"),
  behavior_evidence_invalid: () => reason({}, { browser: { userAgent: DESKTOP_UA, plugins: [{}], webdriver: false } }, "behavior_evidence_invalid"),
  interaction_report_invalid: () => reason({}, quietClient({ interaction: { schemaVersion: 0 } }), "interaction_report_invalid")
};

describe("check catalog", () => {
  it("matches the catalog schema", () => {
    expect(validate(catalog), JSON.stringify(validate.errors, null, 2)).toBe(true);
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$id).toBe("https://tells.blowhorn.ai/schemas/v1/check-catalog.schema.json");
  });

  it("lists every check row and no row that the page does not build", () => {
    expect(catalog.checks.map((check) => check.id)).toEqual(CHECKS.map((check) => check.slug));
    for (const [entry, row] of catalog.checks.map((check, index) => [check, CHECKS[index]])) {
      expect(entry).toMatchObject({ id: row.slug, name: row.name, group: row.group, slug: row.slug, page: `/checks/${row.slug}/` });
      expect(existsSync(new URL(`../public/checks/${entry.slug}/index.html`, import.meta.url))).toBe(true);
    }
  });

  it("lists every scored reason on the check that owns it, with the Worker's points", async () => {
    const listed = catalog.checks.flatMap((check) => check.reasons.map((reason) => ({ ...reason, group: check.group, checkId: check.id })));
    expect(listed.map((reason) => reason.id).sort()).toEqual([...REASON_IDS].sort());
    expect(new Set(listed.map((reason) => reason.id)).size).toBe(listed.length);

    for (const check of catalog.checks) {
      const row = CHECKS.find((item) => item.slug === check.id);
      const ids = check.reasons.map((reason) => reason.id);
      expect(row.reasons.every((id) => ids.includes(id)), check.id).toBe(true);
      for (const id of ids) {
        const owner = CHECKS.find((item) => item.reasons.includes(id));
        const entry = check.reasons.find((reason) => reason.id === id);
        if (entry.affects_row === false) {
          expect(owner, id).toBeUndefined();
        } else {
          expect(owner?.slug, id).toBe(check.id);
        }
      }
    }

    for (const entry of listed) {
      if (entry.outcomes) {
        expect(INTERACTION_CHECK_IDS).toContain(entry.id);
        expect(entry.outcomes.map((outcome) => outcome.status)).toEqual(["fail", "warn"]);
        for (const outcome of entry.outcomes) {
          const seen = [];
          scoreInteraction(
            { task: { completed: true }, checks: [{ id: entry.id, status: outcome.status, observed: "catalog probe" }] },
            (points, id, severity) => seen.push({ id, points, severity })
          );
          expect(seen).toEqual([{ id: entry.id, points: outcome.points, severity: outcome.severity }]);
        }
        continue;
      }
      const scored = headerCases[entry.id] ? await scoredHeader(entry.id) : triggers[entry.id]?.();
      expect(scored, entry.id).toMatchObject({ id: entry.id, points: entry.points, severity: entry.severity });
    }
  });

  it("names catalog 1.0.0 on the checks changelog", () => {
    const page = readFileSync(new URL("../public/checks/changelog/index.html", import.meta.url), "utf8");
    expect(page).toContain(catalog.catalog_version);
    expect(page).toContain("1.0.0");
    expect(page).toContain("v0.3.3");
    expect(page).not.toContain("not yet in a release");
    for (const id of ["fingerprint-protection", "behavioural-classification", "interaction"]) {
      expect(catalog.checks.find((check) => check.id === id).since).toBe("v0.3.3");
    }
    const byId = Object.fromEntries(catalog.checks.flatMap((check) => check.reasons).map((reason) => [reason.id, reason.since]));
    for (const id of ["fingerprint_context_inconsistent", "fingerprint_randomized", "behavior_evidence_invalid", "int_focus", "int_visibility"]) {
      expect(byId[id]).toBe("v0.3.3");
    }
  });
});
