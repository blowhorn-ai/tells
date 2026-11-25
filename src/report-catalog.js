// The reports catalog: a redacted record of each visitor report, kept so the checks can be reported on later.
// Redaction is an allow list. Nothing is copied that is not named here: no IP address, no headers, no WebRTC
// candidates, no fingerprint values, no URLs and no referrer.

import catalog from "../schemas/check-catalog.json" with { type: "json" };
import { BUDGET, computeMode } from "./report-budget.js";

export const RETENTION_DAYS = 90; // the longest retention; report-budget.js shortens it when the budget fills
export const COLLECT_HEADER = "x-tells-collect";
export const RUN_HEADER = "x-tells-run";

const RUN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validRunId(value) {
  return typeof value === "string" && RUN_ID_PATTERN.test(value);
}

// A visitor who set the opt-out is not collected. Collection is on until they do: the page and the CLI send
// X-Tells-Collect: off. The Sec-GPC signal is deliberately ignored.
export function collectionOptedOut(request) {
  const collect = String(request.headers.get(COLLECT_HEADER) || "").trim().toLowerCase();
  return collect === "off" || collect === "0" || collect === "false";
}

export function uaFamily(userAgent) {
  const ua = String(userAgent || "");
  const pick = (re, name) => {
    const match = ua.match(re);
    return match ? `${name} ${match[1]}` : null;
  };
  return (
    pick(/\bEdg\/(\d+)/, "Edge") ||
    pick(/\bOPR\/(\d+)/, "Opera") ||
    pick(/\bFirefox\/(\d+)/, "Firefox") ||
    pick(/\b(?:Chrome|Chromium|CriOS)\/(\d+)/, "Chrome") ||
    pick(/\bVersion\/(\d+)[^ ]* (?:Mobile\/\S+ )?Safari\//, "Safari") ||
    (/\bHeadlessChrome\b/.test(ua) ? "HeadlessChrome" : null) ||
    "Other"
  );
}

export function osFamily(userAgent) {
  const ua = String(userAgent || "");
  if (/Windows/i.test(ua)) return "Windows";
  if (/Android/i.test(ua)) return "Android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "iOS";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macOS";
  if (/CrOS/i.test(ua)) return "ChromeOS";
  if (/Linux|X11/i.test(ua)) return "Linux";
  return "Other";
}

function asnClass(server) {
  const heuristic = server?.datacenterHeuristic;
  if (heuristic?.isLikelyDatacenter === true) return "datacenter";
  if (heuristic && heuristic.isLikelyDatacenter === false) return "other";
  return "unknown";
}

function short(value, max) {
  return typeof value === "string" ? value.slice(0, max) : null;
}

export function redactReport(report, runId, now = new Date()) {
  const verdict = report?.verdict || {};
  const server = report?.server || {};
  const reasons = Array.isArray(verdict.reasons)
    ? verdict.reasons.slice(0, 50).map((reason) => ({
        id: short(reason?.id, 64),
        severity: short(reason?.severity, 16),
        points: Number.isFinite(reason?.points) ? reason.points : null
      }))
    : [];
  const detections = Array.isArray(report?.detections)
    ? report.detections.slice(0, 50).map((row) => ({ name: short(row?.name, 64), status: short(row?.status, 24) }))
    : [];
  const received = now.toISOString();
  const expires = new Date(now.getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  return {
    run_id: runId,
    received_at: received,
    received_day: received.slice(0, 10),
    expires_at: expires,
    schema_version: Number.isInteger(report?.schema_version) ? report.schema_version : null,
    catalog_version: catalog.catalog_version,
    score: Number.isFinite(verdict.score) ? verdict.score : null,
    classification: short(verdict.classification, 32),
    risk: short(verdict.risk, 16),
    reasons: JSON.stringify(reasons),
    detections: JSON.stringify(detections),
    ua_family: uaFamily(server.userAgent),
    os_family: osFamily(server.userAgent),
    country: typeof server.cf?.country === "string" ? server.cf.country.slice(0, 2).toUpperCase() : null,
    asn_class: asnClass(server),
    interaction_completed: report?.client?.interaction?.task?.completed === true ? 1 : 0
  };
}

const COLUMNS = [
  "run_id", "received_at", "received_day", "expires_at", "schema_version", "catalog_version", "score",
  "classification", "risk", "reasons", "detections", "ua_family", "os_family", "country", "asn_class",
  "interaction_completed"
];

function dayOf(now) {
  return now.toISOString().slice(0, 10);
}

// Reads today's ledger row and the raw bytes held. Returns null when either cannot be read: the caller then
// writes nothing (fail closed).
export async function readUsage(env, now = new Date()) {
  try {
    const day = (await env.REPORTS.prepare("SELECT accepted, d1_writes FROM ledger WHERE period = ?")
      .bind(dayOf(now)).first()) || { accepted: 0, d1_writes: 0 };
    const held = await env.REPORTS.prepare("SELECT v FROM state WHERE k = 'raw_held_bytes'").first();
    return {
      disabled: String(env.COLLECT_DISABLED || "") === "1",
      ledgerOk: true,
      day,
      rawBytes: held?.v || 0,
      monthClassA: 0
    };
  } catch (_) {
    return null;
  }
}

export async function currentMode(env, now = new Date()) {
  if (!env?.REPORTS) return "off";
  const usage = await readUsage(env, now);
  return usage ? computeMode(usage) : "off";
}

function ledgerUpsert(env, period, accepted, writes) {
  return env.REPORTS.prepare(
    `INSERT INTO ledger (period, accepted, d1_writes) VALUES (?, ?, ?)
     ON CONFLICT(period) DO UPDATE SET accepted = accepted + excluded.accepted, d1_writes = d1_writes + excluded.d1_writes`
  ).bind(period, accepted, writes);
}

// One redacted row per run id; a retry never creates a second row and is not counted twice. Storage is
// optional: without the REPORTS binding nothing is kept. A failure to store never reaches the visitor.
// Returns "stored", "counted", or false.
export async function persistReport(env, report, runId, now = new Date()) {
  if (!env?.REPORTS || !validRunId(runId)) return false;
  try {
    const mode = await currentMode(env, now);
    if (mode === "off") return false;
    const period = dayOf(now);
    if (mode === "count") {
      await ledgerUpsert(env, period, 1, 1).run();
      return "counted";
    }
    const row = redactReport(report, runId, now);
    const marks = COLUMNS.map(() => "?").join(", ");
    const inserted = await env.REPORTS.prepare(`INSERT OR IGNORE INTO reports (${COLUMNS.join(", ")}) VALUES (${marks})`)
      .bind(...COLUMNS.map((column) => row[column]))
      .run();
    if (inserted?.meta?.changes === 0) return "stored";
    await ledgerUpsert(env, period, 1, BUDGET.writesPerReport).run();
    return "stored";
  } catch (_) {
    return false;
  }
}

// A visitor who turns collection off after the page already posted asks for the run's record to be removed.
// The total collected does not go down; the removal is counted separately.
export async function forgetReport(env, runId, now = new Date()) {
  if (!env?.REPORTS || !validRunId(runId)) return false;
  try {
    const gone = await env.REPORTS.prepare("DELETE FROM reports WHERE run_id = ?").bind(runId).run();
    if (gone?.meta?.changes > 0) {
      await env.REPORTS.prepare(
        `INSERT INTO ledger (period, removed, d1_writes) VALUES (?, 1, 2)
         ON CONFLICT(period) DO UPDATE SET removed = removed + 1, d1_writes = d1_writes + 2`
      ).bind(dayOf(now)).run();
    }
    return true;
  } catch (_) {
    return false;
  }
}
