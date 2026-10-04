// Run database (runs.sqlite): queryable tables, fast-start cache, migration and robustness.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import initSqlJs, { type SqlJsStatic } from 'sql.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { RUN_DB_SCHEMA, RunDb, type RunDbRow } from '../src/runDb';
import type { IndexedRun } from '../src/runIndex';
import { makeRun } from './helpers';

let SQL: SqlJsStatic;
beforeAll(async () => {
  // Same loading path as the extension: the WebAssembly is passed as bytes, nothing is fetched.
  const wasm = readFileSync(join(__dirname, '..', 'node_modules', 'sql.js', 'dist', 'sql-wasm.wasm'));
  SQL = await initSqlJs({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer });
});

const state = (key: string): IndexedRun => ({
  key,
  dirName: key.split('/').pop()!,
  location: `runs/${key.split('/').pop()}`,
  runJson: { stamp: { mtimeMs: 1, size: 10 }, value: null, error: null, warnings: [] },
  params: { stamp: { mtimeMs: 1, size: 10 }, value: { 'optim.lr': 0.001 }, error: null, warnings: [] },
  metrics: { stamp: null, value: null, error: null, warnings: [] },
  jsonlStamp: null,
  jsonlOutside: false,
  peekedNames: [],
  first: { 'val/loss': 1.2 },
  headBytes: 100,
});

const row = (key: string, over: Parameters<typeof makeRun>[0] extends infer T ? Partial<T> : never = {}): RunDbRow => ({
  state: state(key),
  path: `/w/traceml/runs/${key.split('/').pop()}`,
  summary: makeRun({
    key,
    name: key.split('/').pop()!,
    group: 'sweep',
    tags: ['cv', 'fast'],
    startedAt: Date.UTC(2026, 9, 1, 12, 0, 0),
    params: { 'optim.lr': 0.001, 'model.name': 'resnet', aug: true },
    first: { 'val/loss': 1.2 },
    last: { 'val/loss': 0.4 },
    best: { 'val/auc': { value: 0.9, step: 7, epoch: 7, mode: 'max' } },
    summary: { 'test/auc': 0.88, ckpt: 'best.pt' },
    ...over,
  }),
});

describe('run database', () => {
  it('creates the schema and stores runs, config and metrics in queryable tables', () => {
    const { db, fresh } = RunDb.open(SQL, null);
    expect(fresh).toBe(true);
    db.update([row('/w/runs/a'), row('/w/runs/b', { params: { 'optim.lr': 0.01 }, best: { 'val/auc': { value: 0.7, step: 2, epoch: 2, mode: 'max' } } })], []);
    expect(db.query('SELECT name, group_name, tags, started_at, path FROM runs ORDER BY name')).toEqual([
      ['a', 'sweep', 'cv;fast', '2026-10-01T12:00:00.000Z', '/w/traceml/runs/a'],
      ['b', 'sweep', 'cv;fast', '2026-10-01T12:00:00.000Z', '/w/traceml/runs/b'],
    ]);
    expect(db.query("SELECT key, value FROM config WHERE run_key = '/w/runs/a' ORDER BY key")).toEqual([
      ['aug', 1],
      ['model.name', 'resnet'],
      ['optim.lr', 0.001],
    ]);
    expect(db.query("SELECT metric, kind, value, step, mode FROM metrics WHERE run_key = '/w/runs/a' ORDER BY kind, metric")).toEqual([
      ['val/auc', 'best', 0.9, 7, 'max'],
      ['val/loss', 'last', 0.4, null, null],
      ['val/loss', 'start', 1.2, null, null],
      ['ckpt', 'summary', 'best.pt', null, null],
      ['test/auc', 'summary', 0.88, null, null],
    ]);
    // the kind of query an agent would run
    expect(
      db.query(`SELECT r.name, c.value AS lr, m.value AS best_auc FROM runs r
                JOIN config c ON c.run_key = r.key AND c.key = 'optim.lr'
                JOIN metrics m ON m.run_key = r.key AND m.metric = 'val/auc' AND m.kind = 'best'
                WHERE m.value > 0.8`),
    ).toEqual([['a', 0.001, 0.9]]);
  });

  it('updates changed runs, deletes removed ones, and survives export / reopen', () => {
    const { db } = RunDb.open(SQL, null);
    db.update([row('/w/runs/a'), row('/w/runs/b')], []);
    db.update([row('/w/runs/a', { params: { 'optim.lr': 0.5 } })], ['/w/runs/b'], { written_at: 'now' });
    const reopened = RunDb.open(SQL, db.export());
    expect(reopened.fresh).toBe(false);
    expect(reopened.db.keys()).toEqual(['/w/runs/a']);
    expect(reopened.db.query("SELECT value FROM config WHERE key = 'optim.lr'")).toEqual([[0.5]]);
    expect(reopened.db.query("SELECT COUNT(*) FROM metrics WHERE run_key = '/w/runs/b'")).toEqual([[0]]);
    expect(reopened.db.query("SELECT value FROM meta WHERE key = 'schema'")).toEqual([[String(RUN_DB_SCHEMA)]]);
    expect(reopened.db.load().map((r) => r.key)).toEqual(['/w/runs/a']);
    expect(reopened.db.load()[0]!.first).toEqual({ 'val/loss': 1.2 });
  });

  it('starts fresh from a corrupt file, a non-database or another schema version', () => {
    expect(RunDb.open(SQL, new TextEncoder().encode('definitely not sqlite')).fresh).toBe(true);
    expect(RunDb.open(SQL, new Uint8Array(0)).fresh).toBe(true);
    const other = new SQL.Database();
    other.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES ('schema', '999');");
    expect(RunDb.open(SQL, other.export()).fresh).toBe(true);
  });

  it('skips tampered fast-start rows instead of trusting them', () => {
    const { db } = RunDb.open(SQL, null);
    db.update([row('/w/runs/a'), row('/w/runs/b')], []);
    const raw = new SQL.Database(db.export());
    raw.run("UPDATE run_cache SET state = '{\"key\": 5}' WHERE run_key = '/w/runs/b'");
    raw.run("INSERT INTO run_cache VALUES ('/w/runs/c', 'not json')");
    expect(RunDb.open(SQL, raw.export()).db.load().map((r) => r.key)).toEqual(['/w/runs/a']);
  });

  it('a failed update leaves the previous content untouched', () => {
    const { db } = RunDb.open(SQL, null);
    db.update([row('/w/runs/a')], []);
    const bad = row('/w/runs/b');
    (bad.summary as { tags: unknown }).tags = null; // makes the insert throw mid-transaction
    expect(() => db.update([row('/w/runs/a', { name: 'changed' }), bad], [])).toThrow();
    expect(db.query('SELECT name FROM runs')).toEqual([['a']]);
  });
});
