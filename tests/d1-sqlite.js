// A D1-shaped adapter over node:sqlite, so the tests run the real SQL and the real migration.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

export function createD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../migrations/0001_reports.sql", import.meta.url), "utf8"));
  const stats = { statements: 0, failNext: false };
  const statement = (sql, params = []) => ({
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
    prepare: (sql) => statement(sql),
    async batch(list) {
      const out = [];
      for (const item of list) out.push(await item.run());
      return out;
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
