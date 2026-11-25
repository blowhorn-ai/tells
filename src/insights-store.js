import { WINDOWS, buildInsights, windowStart } from "./insights.js";

// The aggregates scan is the one expensive read (about 200k rows for 90 days). It runs from the scheduled job, at
// most once every REFRESH_HOURS, one scan for all windows. Requests only ever read the stored payload (one row).
const REFRESH_HOURS = 6;

export async function refreshInsights(env, now = new Date()) {
  if (!env?.REPORTS) return { skipped: "no-db" };
  const last = await env.REPORTS.prepare("SELECT built_at FROM insights_snapshot WHERE window = ?").bind(WINDOWS[WINDOWS.length - 1]).first();
  if (last?.built_at && now - new Date(last.built_at) < REFRESH_HOURS * 3600 * 1000 - 5 * 60 * 1000) return { skipped: "fresh" };
  const widest = Math.max(...WINDOWS);
  const found = await env.REPORTS.prepare("SELECT day, dim, k, n FROM agg_counts WHERE day >= ?").bind(windowStart(now, widest)).all();
  const rows = found?.results || [];
  const statements = WINDOWS.map((days) => {
    const start = windowStart(now, days);
    const payload = JSON.stringify({ enabled: true, ...buildInsights(rows.filter((r) => r.day >= start), days, now) });
    return env.REPORTS.prepare("INSERT OR REPLACE INTO insights_snapshot (window, built_at, payload) VALUES (?, ?, ?)").bind(days, now.toISOString(), payload);
  });
  statements.push(env.REPORTS.prepare(
    `INSERT INTO ledger (period, d1_writes) VALUES (?, ?)
     ON CONFLICT(period) DO UPDATE SET d1_writes = d1_writes + excluded.d1_writes`
  ).bind(now.toISOString().slice(0, 10), WINDOWS.length));
  await env.REPORTS.batch(statements);
  return { built: WINDOWS.length, rowsRead: rows.length };
}

// One row read. Null when nothing has been built yet.
export async function readInsightsPayload(env, days) {
  const row = await env.REPORTS.prepare("SELECT payload FROM insights_snapshot WHERE window = ?").bind(days).first();
  return row?.payload || null;
}
