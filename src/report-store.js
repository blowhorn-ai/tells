// Hourly compaction, aggregates, pruning and the collected-total figure (blowhorn-ai/tells#108).
// Ingest (report-catalog.js) writes one redacted row per run. Once an hour this module turns waiting rows into
// aggregates and, when the budget mode allows, one gzipped NDJSON object in R2 per hour. R2 write operations
// follow the clock, not traffic: at most a few a day per hour with data, against a 500,000 a month budget.

import { BUDGET, computeMode, keepRaw, retentionDays } from "./report-budget.js";
import { readUsage } from "./report-catalog.js";

const BATCH = 2000;

function hourStart(now) {
  const d = new Date(now);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

async function gzip(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function parseList(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

// Fixed shapes only: identifiers and small enums, never free text from the visitor.
export function aggregateRow(row, bump) {
  const day = row.received_day;
  const cls = row.classification || "none";
  bump(day, "total", "all");
  bump(day, "class", cls);
  bump(day, "risk", row.risk || "none");
  if (Number.isFinite(row.score)) bump(day, "score", String(Math.min(9, Math.max(0, Math.floor(row.score / 10)))));
  const reasons = [...new Set(parseList(row.reasons).map((reason) => reason?.id).filter(Boolean))].sort();
  for (const id of reasons) bump(day, "reason", id);
  const top = reasons.slice(0, 6);
  for (let i = 0; i < top.length; i += 1) {
    for (let j = i + 1; j < top.length; j += 1) bump(day, "pair", `${top[i]}|${top[j]}`);
  }
  for (const check of parseList(row.detections)) {
    if (check?.name && check?.status) bump(day, "check", `${check.name}|${check.status}`);
  }
  bump(day, "browser", `${row.ua_family || "Other"}|${row.os_family || "Other"}|${cls}`);
  bump(day, "country", row.country || "unknown");
  bump(day, "asn", `${row.asn_class || "unknown"}|${cls}`);
  bump(day, "interaction", `${cls}|${row.interaction_completed ? 1 : 0}`);
}

function rawLine(row) {
  return JSON.stringify({
    run_id: row.run_id,
    received_at: row.received_at,
    schema_version: row.schema_version,
    catalog_version: row.catalog_version,
    score: row.score,
    classification: row.classification,
    risk: row.risk,
    reasons: parseList(row.reasons),
    detections: parseList(row.detections),
    ua_family: row.ua_family,
    os_family: row.os_family,
    country: row.country,
    asn_class: row.asn_class,
    interaction_completed: row.interaction_completed
  });
}

async function chunkedBatch(env, statements) {
  for (let i = 0; i < statements.length; i += 50) await env.REPORTS.batch(statements.slice(i, i + 50));
}

export async function compactReports(env, now = new Date()) {
  if (!env?.REPORTS) return { skipped: "no-db" };
  const usage = await readUsage(env, now);
  if (!usage) return { skipped: "ledger-unreadable", mode: "off" };
  const monthStart = `${now.toISOString().slice(0, 7)}-01`;
  const month = await env.REPORTS.prepare("SELECT COALESCE(SUM(r2_puts), 0) AS puts FROM ledger WHERE period >= ?")
    .bind(monthStart).first();
  usage.monthClassA = month?.puts || 0;
  const mode = computeMode(usage);
  if (mode === "off") return { mode };

  const cutoff = hourStart(now).toISOString();
  const found = await env.REPORTS.prepare(
    "SELECT rowid AS id, * FROM reports WHERE state = 0 AND received_at < ? ORDER BY rowid LIMIT ?"
  ).bind(cutoff, BATCH).all();
  const rows = found?.results || [];
  if (rows.length === 0) return { mode, compacted: 0, objects: 0 };

  // Raw objects first. A failed put aborts before anything is marked, and the next hour retries the same rows
  // under the same keys.
  const objects = [];
  if (env.RAW && (mode === "normal" || mode === "tighten" || mode === "sample")) {
    const groups = new Map();
    for (const row of rows) {
      if (!keepRaw(mode, row.run_id, parseList(row.reasons).length)) continue;
      const hour = row.received_at.slice(0, 13);
      if (!groups.has(hour)) groups.set(hour, []);
      groups.get(hour).push(row);
    }
    for (const [hour, group] of groups) {
      const body = await gzip(`${group.map(rawLine).join("\n")}\n`);
      const key = `reports/${hour.slice(0, 4)}/${hour.slice(5, 7)}/${hour.slice(8, 10)}/${hour.slice(11, 13)}-${group[0].id}.ndjson.gz`;
      await env.RAW.put(key, body, { httpMetadata: { contentType: "application/gzip" } });
      objects.push({ key, hour: `${hour}:00:00.000Z`, bytes: body.byteLength, reports: group.length });
    }
  }

  const cells = new Map();
  const bump = (day, dim, k) => {
    const id = `${day}\u0000${dim}\u0000${k}`;
    cells.set(id, (cells.get(id) || 0) + 1);
  };
  for (const row of rows) aggregateRow(row, bump);

  const statements = [];
  for (const [id, n] of cells) {
    const [day, dim, k] = id.split("\u0000");
    statements.push(env.REPORTS.prepare(
      `INSERT INTO agg_counts (day, dim, k, n) VALUES (?, ?, ?, ?)
       ON CONFLICT(day, dim, k) DO UPDATE SET n = n + excluded.n`
    ).bind(day, dim, k, n));
  }
  for (const object of objects) {
    statements.push(env.REPORTS.prepare("INSERT OR REPLACE INTO raw_objects (key, hour, bytes, reports) VALUES (?, ?, ?, ?)")
      .bind(object.key, object.hour, object.bytes, object.reports));
  }
  const maxId = rows[rows.length - 1].id;
  statements.push(env.REPORTS.prepare("UPDATE reports SET state = 1 WHERE state = 0 AND rowid <= ? AND received_at < ?")
    .bind(maxId, cutoff));
  const bytes = objects.reduce((sum, object) => sum + object.bytes, 0);
  const writes = cells.size + objects.length + rows.length * 2 + 2;
  statements.push(env.REPORTS.prepare(
    `INSERT INTO ledger (period, d1_writes, r2_puts, r2_bytes) VALUES (?, ?, ?, ?)
     ON CONFLICT(period) DO UPDATE SET d1_writes = d1_writes + excluded.d1_writes,
       r2_puts = r2_puts + excluded.r2_puts, r2_bytes = r2_bytes + excluded.r2_bytes`
  ).bind(now.toISOString().slice(0, 10), writes, objects.length, bytes));
  if (bytes > 0) {
    statements.push(env.REPORTS.prepare(
      `INSERT INTO state (k, v) VALUES ('raw_held_bytes', ?)
       ON CONFLICT(k) DO UPDATE SET v = v + excluded.v`
    ).bind(bytes));
  }
  await chunkedBatch(env, statements);
  return { mode, compacted: rows.length, objects: objects.length, cells: cells.size };
}

// Deletes catalog rows and R2 objects past the retention for the current mode. Aggregates are kept. Rows that
// have not been aggregated yet are never deleted.
export async function pruneReports(env, now = new Date()) {
  if (!env?.REPORTS) return false;
  try {
    const usage = await readUsage(env, now);
    const mode = usage ? computeMode(usage) : "off";
    const days = retentionDays(mode);
    const cutoff = new Date(now.getTime() - days * 86400000).toISOString();
    const deleted = await env.REPORTS.prepare("DELETE FROM reports WHERE state = 1 AND received_at < ?").bind(cutoff).run();
    let freed = 0;
    for (;;) {
      const old = await env.REPORTS.prepare("SELECT key, bytes FROM raw_objects WHERE hour < ? LIMIT 200").bind(cutoff).all();
      const list = old?.results || [];
      if (list.length === 0) break;
      if (env.RAW) await env.RAW.delete(list.map((object) => object.key));
      const statements = list.map((object) => env.REPORTS.prepare("DELETE FROM raw_objects WHERE key = ?").bind(object.key));
      await chunkedBatch(env, statements);
      freed += list.reduce((sum, object) => sum + object.bytes, 0);
      if (list.length < 200) break;
    }
    if (freed > 0) {
      await env.REPORTS.prepare("UPDATE state SET v = MAX(0, v - ?) WHERE k = 'raw_held_bytes'").bind(freed).run();
    }
    const writes = (deleted?.meta?.changes || 0) * 2;
    if (writes > 0) {
      await env.REPORTS.prepare(
        `INSERT INTO ledger (period, d1_writes) VALUES (?, ?)
         ON CONFLICT(period) DO UPDATE SET d1_writes = d1_writes + excluded.d1_writes`
      ).bind(now.toISOString().slice(0, 10), writes).run();
    }
    return true;
  } catch (_) {
    return false;
  }
}

// The collected total is monotonic: the sum of accepted over all days, which pruning never touches.
export async function collectionStats(env, now = new Date()) {
  if (!env?.REPORTS) return { enabled: false, as_of: now.toISOString() };
  try {
    const totals = await env.REPORTS.prepare(
      "SELECT COALESCE(SUM(accepted), 0) AS total, COALESCE(SUM(removed), 0) AS removed, MIN(period) AS since FROM ledger"
    ).first();
    const held = await env.REPORTS.prepare("SELECT COUNT(*) AS n FROM reports").first();
    return {
      enabled: true,
      total_collected: totals?.total || 0,
      removed_on_request: totals?.removed || 0,
      held_now: held?.n || 0,
      since: totals?.since || null,
      retention_days: 90,
      as_of: now.toISOString()
    };
  } catch (_) {
    return { enabled: false, as_of: now.toISOString() };
  }
}

export { BUDGET };
