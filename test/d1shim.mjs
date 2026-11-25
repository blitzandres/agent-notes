// Minimal Cloudflare D1 shim over node:sqlite (Node >=22.5, --experimental-sqlite). Local tests only.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export function makeD1(files = []) {
  const db = new DatabaseSync(':memory:');
  for (const f of files) {
    const sql = readFileSync(f, 'utf8').replace(/--[^\n]*/g, '');
    for (const stmt of sql.split(';').map((x) => x.trim()).filter(Boolean)) {
      try { db.exec(stmt); }
      catch (e) {
        if (!/duplicate column|already exists/i.test(e.message)) {
          throw new Error(f + ': ' + e.message + '\n' + stmt);
        }
      }
    }
  }
  const norm = (v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);
  class Stmt {
    constructor(sql, args = []) { this.sql = sql; this.args = args; }
    bind(...a) { return new Stmt(this.sql, a.map(norm)); }
    _p() { return db.prepare(this.sql); }
    async first(col) {
      const r = this._p().get(...this.args);
      if (!r) return null;
      return col ? r[col] : { ...r };
    }
    async all() {
      return { results: this._p().all(...this.args).map((r) => ({ ...r })), success: true };
    }
    async run() {
      const p = this._p();
      if (/\breturning\b/i.test(this.sql)) { p.all(...this.args); return { success: true }; }
      const r = p.run(...this.args);
      return { success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
    }
    async raw() {
      return this._p().all(...this.args).map((r) => Object.values(r));
    }
  }
  return {
    raw: db,
    prepare: (sql) => new Stmt(sql),
    batch: async (stmts) => Promise.all(stmts.map((s) => s.run())),
    exec: async (sql) => { db.exec(sql); return { count: 1 }; },
  };
}
