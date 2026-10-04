// The run database: `<cache>/runs.sqlite`, a small SQLite file (via sql.js, pure WebAssembly).
// It has two jobs:
//   1. Fast startup: `run_cache` holds the parsed state of every run (with file mtimes/sizes),
//      so unchanged runs are not parsed again (it replaces runs-index.json).
//   2. A queryable copy of the run table for people and agents: `runs`, `config` and `metrics`
//      (start / last / best / summary values), e.g. with `sqlite3 traceml/.cache/runs.sqlite`.
// The full metric history stays in each run's metrics.jsonl. Pure: no vscode, no I/O; the caller
// loads sql.js and reads/writes the file bytes.
//
// The file lives in the workspace, so everything read back is validated (parseIndexedRun), and it
// never decides where TraceML reads: run folders always come from discovery.
import type { Database, SqlJsStatic, SqlValue } from 'sql.js';
import { parseIndexedRun, type IndexedRun } from './runIndex';
import type { RunSummary, Scalar } from './types';

/** Bump when the schema changes; an older or newer file is rebuilt from the run folders. */
export const RUN_DB_SCHEMA = 1;

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;
CREATE TABLE runs (
  key TEXT PRIMARY KEY,      -- absolute run directory (normalized)
  id TEXT, name TEXT, group_name TEXT, tags TEXT, notes TEXT,
  status TEXT,               -- as written in run.json (running/completed/failed/killed/unknown)
  display_status TEXT,       -- as shown when the row was written (adds "stale")
  started_at TEXT, ended_at TEXT, heartbeat_at TEXT,   -- ISO-8601 UTC
  duration_s REAL, step REAL, epoch REAL,
  path TEXT, location TEXT, legacy INTEGER, warnings TEXT
) WITHOUT ROWID;
CREATE TABLE config (run_key TEXT NOT NULL, key TEXT NOT NULL, value, PRIMARY KEY (run_key, key)) WITHOUT ROWID;
CREATE TABLE metrics (
  run_key TEXT NOT NULL, metric TEXT NOT NULL,
  kind TEXT NOT NULL,        -- start | last | best | summary
  value,                     -- number (summary values may be text)
  step REAL, mode TEXT,      -- best only: where it happened, max/min
  PRIMARY KEY (run_key, metric, kind)
) WITHOUT ROWID;
CREATE TABLE run_cache (run_key TEXT PRIMARY KEY, state TEXT NOT NULL) WITHOUT ROWID;
CREATE INDEX config_by_key ON config (key, value);
CREATE INDEX metrics_by_metric ON metrics (metric, kind, value);
`;

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/** Scalars as SQLite values: booleans become 1/0, non-finite numbers NULL. */
function sqlValue(v: Scalar | undefined): SqlValue {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  return v;
}

export interface RunDbRow {
  state: IndexedRun;
  summary: RunSummary;
  /** Absolute run directory. */
  path: string;
}

export class RunDb {
  private constructor(private readonly db: Database) {}

  /**
   * Opens the database from file bytes. A missing, corrupt or other-schema file gives a fresh,
   * empty database (`fresh` = true), so the runs are simply parsed from disk again.
   */
  static open(SQL: SqlJsStatic, bytes: Uint8Array | null): { db: RunDb; fresh: boolean } {
    if (bytes && bytes.length) {
      try {
        const db = new SQL.Database(bytes);
        const v = db.exec("SELECT value FROM meta WHERE key = 'schema'")[0]?.values[0]?.[0];
        if (Number(v) === RUN_DB_SCHEMA) return { db: new RunDb(db), fresh: false };
        db.close();
      } catch {
        // not a database / unexpected tables: start over
      }
    }
    const db = new SQL.Database();
    db.exec(SCHEMA);
    db.run("INSERT INTO meta VALUES ('schema', ?)", [String(RUN_DB_SCHEMA)]);
    return { db: new RunDb(db), fresh: true };
  }

  /** Parsed run states for seeding the store; malformed rows are skipped. */
  load(): IndexedRun[] {
    const out: IndexedRun[] = [];
    const st = this.db.prepare('SELECT state FROM run_cache');
    try {
      while (st.step()) {
        const [text] = st.get();
        try {
          const r = parseIndexedRun(JSON.parse(String(text)));
          if (r) out.push(r);
        } catch {
          // invalid JSON: skip the row
        }
      }
    } finally {
      st.free();
    }
    return out;
  }

  /** Writes changed runs and deletes removed ones, in one transaction. */
  update(rows: readonly RunDbRow[], removed: readonly string[], meta: Record<string, string> = {}): void {
    if (!rows.length && !removed.length && !Object.keys(meta).length) return;
    const db = this.db;
    db.exec('BEGIN');
    try {
      const del = ['runs WHERE key', 'config WHERE run_key', 'metrics WHERE run_key', 'run_cache WHERE run_key'].map((t) => db.prepare(`DELETE FROM ${t} = ?`));
      const insRun = db.prepare('INSERT INTO runs VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
      const insCfg = db.prepare('INSERT OR REPLACE INTO config VALUES (?,?,?)');
      const insMet = db.prepare('INSERT OR REPLACE INTO metrics VALUES (?,?,?,?,?,?)');
      const insCache = db.prepare('INSERT INTO run_cache VALUES (?,?)');
      try {
        for (const key of [...removed, ...rows.map((r) => r.summary.key)]) for (const d of del) d.run([key]);
        for (const { state, summary: s, path } of rows) {
          insRun.run([s.key, s.id, s.name, s.group, s.tags.join(';'), s.notes, s.status, s.displayStatus, iso(s.startedAt), iso(s.endedAt), iso(s.heartbeatAt), sqlValue(s.durationS), sqlValue(s.step), sqlValue(s.epoch), path, s.location, s.legacy ? 1 : 0, s.warnings.length ? JSON.stringify(s.warnings) : null]);
          for (const [k, v] of Object.entries(s.params)) insCfg.run([s.key, k, sqlValue(v)]);
          for (const [k, v] of Object.entries(s.first)) insMet.run([s.key, k, 'start', sqlValue(v), null, null]);
          for (const [k, v] of Object.entries(s.last)) insMet.run([s.key, k, 'last', sqlValue(v), null, null]);
          for (const [k, b] of Object.entries(s.best)) insMet.run([s.key, k, 'best', sqlValue(b.value), sqlValue(b.step), b.mode]);
          for (const [k, v] of Object.entries(s.summary)) insMet.run([s.key, k, 'summary', sqlValue(v), null, null]);
          insCache.run([s.key, JSON.stringify(state)]);
        }
        for (const [k, v] of Object.entries(meta)) db.run('INSERT OR REPLACE INTO meta VALUES (?, ?)', [k, v]);
      } finally {
        for (const st of [...del, insRun, insCfg, insMet, insCache]) st.free();
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Keys of the runs stored in the database. */
  keys(): string[] {
    return (this.db.exec('SELECT key FROM runs')[0]?.values ?? []).map((r) => String(r[0]));
  }

  /** Runs an ad-hoc query (tests / debugging). */
  query(sql: string, params: SqlValue[] = []): SqlValue[][] {
    return this.db.exec(sql, params)[0]?.values ?? [];
  }

  /** The database file bytes. */
  export(): Uint8Array {
    return this.db.export();
  }

  close(): void {
    this.db.close();
  }
}
