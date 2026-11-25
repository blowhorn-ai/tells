// A D1-shaped adapter over node:sqlite, so the tests run the real SQL and the real migration.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

export function createD1() {
  const db = new DatabaseSync(":memory:");
  for (const file of ["0001_reports.sql", "0002_insights.sql"]) db.exec(readFileSync(new URL(`../migrations/${file}`, import.meta.url), "utf8"));
  const stats = { statements: 0, failNext: false };
  const queries = [];
  const statement = (sql, params = []) => (queries.push(sql), {
    bind: (...values) => statement(sql, values),
    async run() {
      stats.statements += 1;
      if (stats.failNext) throw new Error("D1 unavailable");
      const result = db.prepare(sql).run(...params);
      return { success: true, meta: { changes: Number(result.changes) } };
    },
    async first() {
      stats.statements += 1;
      if (stats.failNext) throw new Error("D1 unavailable");
      return db.prepare(sql).get(...params) ?? null;
    },
    async all() {
      stats.statements += 1;
      if (stats.failNext) throw new Error("D1 unavailable");
      return { results: db.prepare(sql).all(...params) };
    },
    _sql: sql,
    _params: params
  });
  return {
    db,
    stats,
    queries,
    prepare: (sql) => statement(sql),
    async batch(list) {
      stats.batches = (stats.batches || 0) + 1;
      db.exec("BEGIN");
      try {
        const out = [];
        for (const [index, item] of list.entries()) {
          if (stats.failBatchAt === index) throw new Error("D1 batch failed");
          out.push(await item.run());
        }
        db.exec("COMMIT");
        return out;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
  };
}

export function createR2() {
  const objects = new Map();
  const calls = { put: 0, delete: 0, get: 0, list: 0 };
  return {
    objects,
    calls,
    async put(key, body) { calls.put += 1; objects.set(key, body); },
    async delete(keys) { calls.delete += 1; for (const key of [].concat(keys)) objects.delete(key); },
    async get() { calls.get += 1; return null; },
    async list() { calls.list += 1; return { objects: [] }; }
  };
}
