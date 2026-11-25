// Hourly compaction, aggregates, pruning and the collected-total figure (blowhorn-ai/tells#108).
// Ingest (report-catalog.js) writes one redacted row per run. Once an hour this module turns waiting rows into
// aggregates and, when the budget mode allows, one gzipped NDJSON object in R2 per hour. R2 write operations
// follow the clock, not traffic: at most a few a day per hour with data, against a 500,000 a month budget.

import { BUDGET, computeMode, keepRaw, retentionDays } from "./report-budget.js";
import { readUsage } from "./report-catalog.js";

// Rows per atomic batch, and batches per invocation. One batch is one D1 transaction.
const CHUNK = 250;
const MAX_BATCHES = 8;
const MAX_STATEMENTS = 900;

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

// How many of the waiting rows go into one batch: halved until the aggregate cells plus the hour groups fit in
// one D1 batch. Chosen before any R2 put, so every object written belongs to a chunk that commits its bookkeeping.
function chunkSize(rows) {
  let size = rows.length;
  for (;;) {
    const cells = new Map();
    const hours = new Set();
    for (const row of rows.slice(0, size)) {
      aggregateRow(row, (d, dim, k) => cells.set(`${d}\u0000${dim}\u0000${k}`, 1));
      hours.add(row.received_at.slice(0, 13));
    }
    if (cells.size + hours.size + 4 <= MAX_STATEMENTS || size === 1) return size;
    size = Math.max(1, Math.floor(size / 2));
  }
}

// Everything one chunk changes in D1 as a single batch: the aggregates, the raw object records, the state mark
// and the ledger. D1 runs a batch as one transaction, so it all commits or none of it does.
function planChunk(env, part, cutoff, objects, day) {
  const cells = new Map();
  const bump = (d, dim, k) => {
    const id = `${d}\u0000${dim}\u0000${k}`;
    cells.set(id, (cells.get(id) || 0) + 1);
  };
  for (const row of part) aggregateRow(row, bump);
  const statements = [];
  for (const [id, n] of cells) {
    const [d, dim, k] = id.split("\u0000");
    statements.push(env.REPORTS.prepare(
      `INSERT INTO agg_counts (day, dim, k, n) VALUES (?, ?, ?, ?)
       ON CONFLICT(day, dim, k) DO UPDATE SET n = n + excluded.n`
    ).bind(d, dim, k, n));
  }
  for (const object of objects) {
    statements.push(env.REPORTS.prepare("INSERT OR REPLACE INTO raw_objects (key, hour, bytes, reports) VALUES (?, ?, ?, ?)")
      .bind(object.key, object.hour, object.bytes, object.reports));
  }
  statements.push(env.REPORTS.prepare("UPDATE reports SET state = 1 WHERE state = 0 AND rowid <= ? AND received_at < ?")
    .bind(part[part.length - 1].id, cutoff));
  const bytes = objects.reduce((sum, object) => sum + object.bytes, 0);
  statements.push(env.REPORTS.prepare(
    `INSERT INTO ledger (period, d1_writes) VALUES (?, ?)
     ON CONFLICT(period) DO UPDATE SET d1_writes = d1_writes + excluded.d1_writes`
  ).bind(day, cells.size + objects.length + part.length * 2 + 2));
  if (bytes > 0) {
    statements.push(env.REPORTS.prepare(
      `INSERT INTO state (k, v) VALUES ('raw_held_bytes', ?)
       ON CONFLICT(k) DO UPDATE SET v = v + excluded.v`
    ).bind(bytes));
  }
  return { statements, count: part.length, cells: cells.size, objects: objects.length };
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
  const day = now.toISOString().slice(0, 10);
  const total = { mode, compacted: 0, objects: 0, cells: 0 };
  for (let batch = 0; batch < MAX_BATCHES; batch += 1) {
    const found = await env.REPORTS.prepare(
      "SELECT rowid AS id, * FROM reports WHERE state = 0 AND received_at < ? ORDER BY rowid LIMIT ?"
    ).bind(cutoff, CHUNK).all();
    const waiting = found?.results || [];
    if (waiting.length === 0) break;
    const part = waiting.slice(0, chunkSize(waiting));

    // Raw objects for exactly this chunk. Each put is counted in the ledger right away, so a retry after a
    // failed batch never hides an operation. The key depends only on the hour and the first row, so a retry
    // overwrites it.
    const objects = [];
    if (env.RAW && (mode === "normal" || mode === "tighten" || mode === "sample")) {
      const groups = new Map();
      for (const row of part) {
        if (!keepRaw(mode, row.run_id, parseList(row.reasons).length)) continue;
        const hour = row.received_at.slice(0, 13);
        if (!groups.has(hour)) groups.set(hour, []);
        groups.get(hour).push(row);
      }
      for (const [hour, group] of groups) {
        const body = await gzip(`${group.map(rawLine).join("\n")}\n`);
        const key = `reports/${hour.slice(0, 4)}/${hour.slice(5, 7)}/${hour.slice(8, 10)}/${hour.slice(11, 13)}-${group[0].id}.ndjson.gz`;
        await env.RAW.put(key, body, { httpMetadata: { contentType: "application/gzip" } });
        await env.REPORTS.prepare(
          `INSERT INTO ledger (period, d1_writes, r2_puts, r2_bytes) VALUES (?, 1, 1, ?)
           ON CONFLICT(period) DO UPDATE SET d1_writes = d1_writes + 1, r2_puts = r2_puts + 1, r2_bytes = r2_bytes + excluded.r2_bytes`
        ).bind(day, body.byteLength).run();
        objects.push({ key, hour: `${hour}:00:00.000Z`, bytes: body.byteLength, reports: group.length });
      }
    }

    const plan = planChunk(env, part, cutoff, objects, day);
    await env.REPORTS.batch(plan.statements);
    total.compacted += plan.count;
    total.objects += plan.objects;
    total.cells += plan.cells;
    if (waiting.length < CHUNK && part.length === waiting.length) break;
  }
  return total;
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
    await env.REPORTS.batch([
      env.REPORTS.prepare("DELETE FROM reports WHERE state = 1 AND received_at < ?").bind(cutoff),
      env.REPORTS.prepare(
        `INSERT INTO ledger (period, pruned, d1_writes) SELECT ?, changes(), changes() * 2 WHERE changes() > 0
         ON CONFLICT(period) DO UPDATE SET pruned = pruned + excluded.pruned, d1_writes = d1_writes + excluded.d1_writes`
      ).bind(now.toISOString().slice(0, 10))
    ]);
    let freed = 0;
    for (;;) {
      const old = await env.REPORTS.prepare("SELECT key, bytes FROM raw_objects WHERE hour < ? LIMIT 200").bind(cutoff).all();
      const list = old?.results || [];
      if (list.length === 0) break;
      if (env.RAW) await env.RAW.delete(list.map((object) => object.key));
      const statements = list.map((object) => env.REPORTS.prepare("DELETE FROM raw_objects WHERE key = ?").bind(object.key));
      await env.REPORTS.batch(statements);
      freed += list.reduce((sum, object) => sum + object.bytes, 0);
      if (list.length < 200) break;
    }
    if (freed > 0) {
      await env.REPORTS.prepare("UPDATE state SET v = MAX(0, v - ?) WHERE k = 'raw_held_bytes'").bind(freed).run();
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
    const t = await env.REPORTS.prepare(
      `SELECT COALESCE(SUM(accepted), 0) AS total, COALESCE(SUM(counted), 0) AS counted,
              COALESCE(SUM(removed), 0) AS removed, COALESCE(SUM(pruned), 0) AS pruned, MIN(period) AS since
       FROM ledger`
    ).first();
    return {
      enabled: true,
      total_collected: t?.total || 0,
      removed_on_request: t?.removed || 0,
      held_now: Math.max(0, (t?.total || 0) - (t?.counted || 0) - (t?.removed || 0) - (t?.pruned || 0)),
      since: t?.since || null,
      retention_days: 90,
      as_of: now.toISOString()
    };
  } catch (_) {
    return { enabled: false, as_of: now.toISOString() };
  }
}

export { BUDGET };
