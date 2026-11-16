import { buildCheckRows, buildVerdictGroupLines, reasonHeadline, SEVERITY_LABEL } from "./checks-view-model.js";
import { verdictWord } from "./voice.js";

const KNOWN_VERDICTS = new Set(["likely_human", "suspicious", "likely_bot", "pending", "failed"]);

const VERSION_WARNING = "Scores are only comparable across the same schema version. Overlapping fields are still compared.";

// A downloaded report is the /api/report body: a verdict plus the client or server object it was scored from.
export function parseReportText(text) {
  if (typeof text !== "string" || !text.trim()) {
    return { ok: false, error: "Paste or drop a report JSON file." };
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, error: "That file is not valid JSON." };
  }
  if (!isTellsReport(value)) {
    return { ok: false, error: "That file is not a Tells report. Use a file saved with Download JSON." };
  }
  return { ok: true, report: value };
}

export function isTellsReport(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (!value.verdict || typeof value.verdict !== "object" || Array.isArray(value.verdict)) return false;
  const client = value.client && typeof value.client === "object";
  const server = value.server && typeof value.server === "object";
  return client || server;
}

// schema_version is the report contract. schemaVersion is accepted for older files that used camel case.
export function reportSchemaVersion(report) {
  const version = report?.schema_version ?? report?.schemaVersion;
  if (version === undefined || version === null || version === "") return null;
  return String(version);
}

export function compareReports(leftText, rightText) {
  const left = acceptSide("A", leftText);
  const right = acceptSide("B", rightText);
  const sides = [left.side, right.side];
  if (!left.report || !right.report) {
    return { sides, versionWarning: null, verdict: null, checks: null, flags: null };
  }

  const leftVersion = left.side.schemaVersion;
  const rightVersion = right.side.schemaVersion;
  const versionWarning = leftVersion && rightVersion && leftVersion === rightVersion ? null : VERSION_WARNING;

  const verdictLeft = verdictSide(left.report);
  const verdictRight = verdictSide(right.report);
  const reasonChanges = diffReasons(left.report, right.report);
  const verdictChanged = verdictLeft.label !== verdictRight.label
    || verdictLeft.score !== verdictRight.score
    || verdictLeft.classification !== verdictRight.classification
    || reasonChanges.length > 0;

  const checks = diffChecks(left.report, right.report);
  const flags = diffFlags(left.report, right.report);

  return {
    sides,
    versionWarning,
    verdict: { changed: verdictChanged, left: verdictLeft, right: verdictRight, reasonChanges },
    checks,
    flags
  };
}

function acceptSide(name, text) {
  const parsed = parseReportText(text);
  if (!parsed.ok) {
    return { report: null, side: { name, accepted: false, error: parsed.error, schemaVersion: null } };
  }
  return {
    report: parsed.report,
    side: { name, accepted: true, error: null, schemaVersion: reportSchemaVersion(parsed.report) }
  };
}

function verdictSide(report) {
  const verdict = report.verdict || {};
  const classification = typeof verdict.classification === "string" ? verdict.classification : null;
  const score = Number.isFinite(Number(verdict.score)) ? Number(verdict.score) : null;
  return {
    label: KNOWN_VERDICTS.has(classification) ? verdictWord(classification) : "No label",
    score,
    classification
  };
}

function reasonView(report) {
  const reasons = Array.isArray(report?.verdict?.reasons) ? report.verdict.reasons : [];
  const byId = new Map();
  for (const reason of reasons) {
    if (!reason || typeof reason.id !== "string" || !reason.id) continue;
    // Headline and severity only. reason.data can hold IPs and other device identifiers.
    byId.set(reason.id, {
      id: reason.id,
      headline: reasonHeadline(reason.id),
      severity: SEVERITY_LABEL[reason.severity] || null
    });
  }
  return byId;
}

function diffReasons(leftReport, rightReport) {
  const left = reasonView(leftReport);
  const right = reasonView(rightReport);
  const ids = [...new Set([...left.keys(), ...right.keys()])].sort();
  const changes = [];
  for (const id of ids) {
    const a = left.get(id);
    const b = right.get(id);
    if (a && b && a.severity === b.severity) continue;
    changes.push({
      id,
      headline: (a || b).headline,
      change: !a ? "added" : !b ? "removed" : "severity",
      leftSeverity: a?.severity ?? null,
      rightSeverity: b?.severity ?? null
    });
  }
  return changes;
}

function checkSide(row) {
  return { status: row.status, statusLabel: row.label, summary: row.summary };
}

function diffChecks(leftReport, rightReport) {
  const left = buildCheckRows(leftReport);
  const right = buildCheckRows(rightReport);
  const rightByName = new Map(right.map((row) => [row.name, row]));
  return left.map((row) => {
    const other = rightByName.get(row.name);
    const leftSide = checkSide(row);
    const rightSide = other ? checkSide(other) : { status: "na", statusLabel: "Not available", summary: "Not in this report" };
    const changed = leftSide.status !== rightSide.status || leftSide.summary !== rightSide.summary;
    return { name: row.name, slug: row.slug, changed, left: leftSide, right: rightSide };
  });
}

function flagSide(line) {
  return { status: line.status, statusLabel: line.statusLabel, sentence: line.sentence };
}

function diffFlags(leftReport, rightReport) {
  const left = buildVerdictGroupLines(buildCheckRows(leftReport));
  const right = buildVerdictGroupLines(buildCheckRows(rightReport));
  return left.map((line, index) => {
    const other = right[index];
    const leftSide = flagSide(line);
    const rightSide = flagSide(other);
    const changed = leftSide.status !== rightSide.status || leftSide.sentence !== rightSide.sentence;
    return { key: line.key, label: line.label, changed, left: leftSide, right: rightSide };
  });
}
