// Free-tier budgets and the mode they select (blowhorn-ai/tells#108). Every limit here is 50% of a Cloudflare
// free allowance (R2 10 GB / 1M Class A / 10M Class B, D1 5 GB / 100k rows written a day / 5M read, Workers
// Free). The Worker fails closed: when a counter is unreadable, or a budget is full, it stops writing. Nothing
// here ever switches to a paid path.

export const BUDGET = Object.freeze({
  dailyReports: 5000,
  dailyD1Writes: 50000,
  d1Bytes: 2.5e9,
  rawBytes: 5e9,
  monthlyClassA: 500000,
  monthlyClassB: 5000000,
  maxReportBytes: 64 * 1024,
  // Index rows count as rows written: 4 at ingest, 2 at compaction, 2 at prune.
  writesPerReport: 8
});

export const MODES = Object.freeze(["normal", "tighten", "sample", "aggregate", "count", "off"]);

// Retention by mode (days). Aggregates are rolled up before anything is deleted, so shortening loses no figure.
export const RETENTION_DAYS_BY_MODE = Object.freeze({
  normal: 90, tighten: 30, sample: 14, aggregate: 14, count: 14, off: 14
});

// A missing counter is 0, but a counter that is present and not a finite number is bad data: it yields NaN,
// and computeMode then stops all writes.
function count(value) {
  if (value === undefined || value === null) return 0;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : Number.NaN;
}

export function usageRatio(usage) {
  const day = usage?.day || {};
  return Math.max(
    count(day.accepted) / BUDGET.dailyReports,
    count(day.d1_writes) / BUDGET.dailyD1Writes,
    count(usage?.rawBytes) / BUDGET.rawBytes,
    count(usage?.monthClassA) / BUDGET.monthlyClassA
  );
}

// usage: { disabled, ledgerOk, day: {accepted, d1_writes}, rawBytes, monthClassA }
export function computeMode(usage) {
  if (!usage || usage.disabled || usage.ledgerOk !== true) return "off";
  const ratio = usageRatio(usage);
  if (!Number.isFinite(ratio)) return "off";
  if (ratio >= 1) return "off";
  if (ratio >= 0.95) return "count";
  if (ratio >= 0.85) return "aggregate";
  if (ratio >= 0.7) return "sample";
  if (ratio >= 0.6) return "tighten";
  return "normal";
}

export function retentionDays(mode) {
  return RETENTION_DAYS_BY_MODE[mode] ?? RETENTION_DAYS_BY_MODE.off;
}

// Sample mode keeps raw for a fixed 1 in 4 of runs by run id, and always for runs with several reasons
// (the rare, interesting ones). Catalog rows and aggregates are kept for every run.
export function keepRaw(mode, runId, reasonCount) {
  if (mode === "normal" || mode === "tighten") return true;
  if (mode !== "sample") return false;
  if (reasonCount >= 3) return true;
  let hash = 0;
  for (const ch of String(runId)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash % 4 === 0;
}
