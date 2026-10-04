// Persistent run index (`<cache>/runs-index.json`): the parsed small files of every run, with the
// mtime/size they were parsed at. On startup the table is filled from it at once; files are then
// re-parsed only when their stamp changed. Pure: no vscode, no I/O.
//
// The index lives in the workspace, so it is treated as untrusted input: every entry is validated
// field by field, and it never decides *where* TraceML reads (run folders always come from
// discovery, which applies the usual confinement checks).
import type { BestMetric, ExitInfo, MetricsSummary, RunMeta, RunStatus, Scalar } from './types';

export const RUN_INDEX_VERSION = 1;

export interface Stamp {
  mtimeMs: number;
  size: number;
}

/** Cached parse of one small file (run.json, params.yaml, metrics.json). */
export interface Cached<T> {
  stamp: Stamp | null; // null = file missing
  value: T | null;
  error: string | null;
  warnings: string[];
}

export interface IndexedRun {
  key: string;
  dirName: string;
  location: string;
  runJson: Cached<RunMeta>;
  params: Cached<Record<string, Scalar>>;
  metrics: Cached<MetricsSummary>;
  jsonlStamp: Stamp | null;
  jsonlOutside: boolean;
  peekedNames: string[];
  first: Record<string, number | null>;
  /** Bytes of metrics.jsonl looked at for `first`/`peekedNames` (the head is complete once it reaches PEEK_BYTES). */
  headBytes: number;
}

export interface RunIndexFile {
  version: typeof RUN_INDEX_VERSION;
  runs: IndexedRun[];
}

// -- validation helpers --------------------------------------------------------------

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const numOrNull = (v: unknown): number | null | undefined => (v === null ? null : isNum(v) ? v : undefined);
const strOrNull = (v: unknown): string | null | undefined => (v === null ? null : typeof v === 'string' ? v : undefined);
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isScalar = (v: unknown): v is Scalar => v === null || typeof v === 'string' || typeof v === 'boolean' || isNum(v);
const STATUSES: readonly RunStatus[] = ['running', 'completed', 'failed', 'killed', 'unknown'];

/** Thrown internally when a field has the wrong type; the whole entry is then dropped. */
class Invalid extends Error {}

function req<T>(v: T | undefined): T {
  if (v === undefined) throw new Invalid();
  return v;
}

function stamp(v: unknown): Stamp | null {
  if (v === null) return null;
  if (!isRec(v) || !isNum(v.mtimeMs) || !isNum(v.size) || v.size < 0) throw new Invalid();
  return { mtimeMs: v.mtimeMs, size: v.size };
}

function record<T>(v: unknown, item: (x: unknown) => T): Record<string, T> {
  if (!isRec(v)) throw new Invalid();
  const out: Record<string, T> = {};
  for (const [k, x] of Object.entries(v)) out[k] = item(x);
  return out;
}

function exitInfo(v: unknown): ExitInfo | null {
  if (v === null) return null;
  if (!isRec(v)) throw new Invalid();
  return {
    code: req(numOrNull(v.code)),
    signal: req(strOrNull(v.signal)),
    errorType: req(strOrNull(v.errorType)),
    errorMessage: req(strOrNull(v.errorMessage)),
    traceback: req(strOrNull(v.traceback)),
  };
}

function meta(v: unknown): RunMeta {
  if (!isRec(v)) throw new Invalid();
  if (!STATUSES.includes(v.status as RunStatus)) throw new Invalid();
  if (!isStrArray(v.tags) || typeof v.notes !== 'string') throw new Invalid();
  if (!(v.command === null || isStrArray(v.command))) throw new Invalid();
  if (!(v.host === null || isRec(v.host)) || !(v.git === null || isRec(v.git))) throw new Invalid();
  if (isRec(v.host) && v.host.gpus !== undefined && !isStrArray(v.host.gpus)) throw new Invalid();
  return {
    schemaVersion: req(numOrNull(v.schemaVersion)),
    id: req(strOrNull(v.id)),
    name: req(strOrNull(v.name)),
    group: req(strOrNull(v.group)),
    tags: v.tags,
    notes: v.notes,
    status: v.status as RunStatus,
    startedAt: req(numOrNull(v.startedAt)),
    endedAt: req(numOrNull(v.endedAt)),
    heartbeatAt: req(numOrNull(v.heartbeatAt)),
    durationS: req(numOrNull(v.durationS)),
    exit: exitInfo(v.exit),
    command: v.command as string[] | null,
    cwd: req(strOrNull(v.cwd)),
    host: v.host as RunMeta['host'],
    git: v.git as RunMeta['git'],
  };
}

function best(v: unknown): BestMetric {
  if (!isRec(v)) throw new Invalid();
  return { value: req(numOrNull(v.value)), step: req(numOrNull(v.step)), epoch: req(numOrNull(v.epoch)), mode: req(strOrNull(v.mode)) };
}

function metricsSummary(v: unknown): MetricsSummary {
  if (!isRec(v)) throw new Invalid();
  return {
    schemaVersion: req(numOrNull(v.schemaVersion)),
    updatedAt: req(numOrNull(v.updatedAt)),
    step: req(numOrNull(v.step)),
    epoch: req(numOrNull(v.epoch)),
    last: record(v.last, (x) => req(numOrNull(x))),
    best: record(v.best, best),
    summary: record(v.summary, (x) => {
      if (!isScalar(x)) throw new Invalid();
      return x;
    }),
  };
}

function cached<T>(v: unknown, value: (x: unknown) => T): Cached<T> {
  if (!isRec(v) || !isStrArray(v.warnings)) throw new Invalid();
  return { stamp: stamp(v.stamp), value: v.value === null ? null : value(v.value), error: req(strOrNull(v.error)), warnings: v.warnings };
}

function indexedRun(v: unknown): IndexedRun {
  if (!isRec(v) || typeof v.key !== 'string' || typeof v.dirName !== 'string' || typeof v.location !== 'string') throw new Invalid();
  if (typeof v.jsonlOutside !== 'boolean' || !isStrArray(v.peekedNames) || !isNum(v.headBytes)) throw new Invalid();
  return {
    key: v.key,
    dirName: v.dirName,
    location: v.location,
    runJson: cached(v.runJson, meta),
    params: cached(v.params, (x) =>
      record(x, (p) => {
        if (!isScalar(p)) throw new Invalid();
        return p;
      }),
    ),
    metrics: cached(v.metrics, metricsSummary),
    jsonlStamp: stamp(v.jsonlStamp),
    jsonlOutside: v.jsonlOutside,
    peekedNames: v.peekedNames,
    first: record(v.first, (x) => req(numOrNull(x))),
    headBytes: v.headBytes,
  };
}

/**
 * Parses an index file. Returns only the valid entries; a missing, corrupt or older-version index
 * gives an empty list (the runs are then simply parsed from disk).
 */
export function parseRunIndex(text: string): IndexedRun[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isRec(doc) || doc.version !== RUN_INDEX_VERSION || !Array.isArray(doc.runs)) return [];
  const out: IndexedRun[] = [];
  for (const r of doc.runs) {
    try {
      out.push(indexedRun(r));
    } catch (e) {
      if (!(e instanceof Invalid)) throw e;
    }
  }
  return out;
}

export function serializeRunIndex(runs: readonly IndexedRun[]): string {
  const doc: RunIndexFile = { version: RUN_INDEX_VERSION, runs: [...runs] };
  return JSON.stringify(doc) + '\n';
}
