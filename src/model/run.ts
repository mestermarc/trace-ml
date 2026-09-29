// Run summary derivation, table columns, sorting and comparison. Pure; used by host and webview.
import type { DisplayStatus, MetricsSummary, RunMeta, RunStatus, RunSummary, Scalar } from '../types';

// ---------------------------------------------------------------------------
// Status / summary
// ---------------------------------------------------------------------------

export function deriveDisplayStatus(
  status: RunStatus,
  heartbeatAt: number | null,
  nowMs: number,
  staleAfterSeconds: number,
): { displayStatus: DisplayStatus; heartbeatKnown: boolean } {
  if (status !== 'running') return { displayStatus: status, heartbeatKnown: heartbeatAt !== null };
  if (heartbeatAt === null) return { displayStatus: 'running', heartbeatKnown: false };
  const stale = nowMs - heartbeatAt > staleAfterSeconds * 1000;
  return { displayStatus: stale ? 'stale' : 'running', heartbeatKnown: true };
}

export function computeDurationS(meta: RunMeta | null, displayStatus: DisplayStatus, nowMs: number): number | null {
  if (!meta) return null;
  if (meta.durationS !== null) return meta.durationS;
  if (meta.startedAt === null) return null;
  if (meta.endedAt !== null) return Math.max(0, (meta.endedAt - meta.startedAt) / 1000);
  if (displayStatus === 'running') return Math.max(0, (nowMs - meta.startedAt) / 1000);
  // stale / killed-without-end: last sign of life
  if (meta.heartbeatAt !== null) return Math.max(0, (meta.heartbeatAt - meta.startedAt) / 1000);
  return null;
}

export interface SummaryInput {
  key: string;
  dirName: string;
  location: string;
  meta: RunMeta | null;
  hasRunJson: boolean;
  params: Record<string, Scalar>;
  metrics: MetricsSummary | null;
  /** Metric names from a loaded or peeked metrics.jsonl. */
  extraMetricNames: string[];
  /** Last step seen in a loaded metrics.jsonl (used when metrics.json is missing). */
  historyStep: number | null;
  warnings: string[];
}

export function buildRunSummary(input: SummaryInput, nowMs: number, staleAfterSeconds: number): RunSummary {
  const { meta, metrics } = input;
  const status: RunStatus = input.hasRunJson && meta ? meta.status : 'unknown';
  const { displayStatus, heartbeatKnown } = deriveDisplayStatus(status, meta?.heartbeatAt ?? null, nowMs, staleAfterSeconds);
  const names = new Set<string>(input.extraMetricNames);
  if (metrics) {
    for (const k of Object.keys(metrics.last)) names.add(k);
    for (const k of Object.keys(metrics.best)) names.add(k);
  }
  return {
    key: input.key,
    id: meta?.id ?? input.dirName,
    name: meta?.name ?? input.dirName,
    group: meta?.group ?? null,
    tags: meta?.tags ?? [],
    notes: meta?.notes ?? '',
    status,
    displayStatus,
    heartbeatKnown,
    startedAt: meta?.startedAt ?? null,
    endedAt: meta?.endedAt ?? null,
    heartbeatAt: meta?.heartbeatAt ?? null,
    durationS: computeDurationS(meta, displayStatus, nowMs),
    step: metrics?.step ?? input.historyStep,
    epoch: metrics?.epoch ?? null,
    params: input.params,
    last: metrics?.last ?? {},
    best: metrics?.best ?? {},
    summary: metrics?.summary ?? {},
    metricNames: [...names].sort(),
    warnings: input.warnings,
    legacy: !input.hasRunJson,
    location: input.location,
  };
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

export type ColumnKind = 'fixed' | 'param' | 'last' | 'best' | 'summary';

export interface ColumnDef {
  id: string;
  kind: ColumnKind;
  key: string;
  label: string;
  numeric: boolean;
}

export const FIXED_COLUMNS: readonly ColumnDef[] = [
  { id: 'status', kind: 'fixed', key: 'status', label: 'status', numeric: false },
  { id: 'name', kind: 'fixed', key: 'name', label: 'name', numeric: false },
  { id: 'group', kind: 'fixed', key: 'group', label: 'group', numeric: false },
  { id: 'started', kind: 'fixed', key: 'started', label: 'started', numeric: true },
  { id: 'duration', kind: 'fixed', key: 'duration', label: 'duration', numeric: true },
  { id: 'step', kind: 'fixed', key: 'step', label: 'step', numeric: true },
];

/** Fixed columns available in the chooser but hidden by default. */
export const OPTIONAL_FIXED_COLUMNS: readonly ColumnDef[] = [
  { id: 'id', kind: 'fixed', key: 'id', label: 'id', numeric: false },
  { id: 'tags', kind: 'fixed', key: 'tags', label: 'tags', numeric: false },
  { id: 'epoch', kind: 'fixed', key: 'epoch', label: 'epoch', numeric: true },
  { id: 'ended', kind: 'fixed', key: 'ended', label: 'ended', numeric: true },
  { id: 'heartbeat', kind: 'fixed', key: 'heartbeat', label: 'heartbeat', numeric: true },
  { id: 'location', kind: 'fixed', key: 'location', label: 'location', numeric: false },
];

export function columnId(kind: Exclude<ColumnKind, 'fixed'>, key: string): string {
  return `${kind}:${key}`;
}

export function parseColumnId(id: string): { kind: ColumnKind; key: string } {
  const i = id.indexOf(':');
  if (i > 0) {
    const kind = id.slice(0, i);
    if (kind === 'param' || kind === 'last' || kind === 'best' || kind === 'summary') return { kind, key: id.slice(i + 1) };
  }
  return { kind: 'fixed', key: id };
}

export function columnValue(run: RunSummary, colId: string): Scalar {
  const { kind, key } = parseColumnId(colId);
  switch (kind) {
    case 'param':
      return run.params[key] ?? null;
    case 'last':
      return run.last[key] ?? null;
    case 'best':
      return run.best[key]?.value ?? null;
    case 'summary':
      return run.summary[key] ?? null;
    case 'fixed':
      switch (key) {
        case 'status':
          return run.displayStatus;
        case 'name':
          return run.name;
        case 'id':
          return run.id;
        case 'group':
          return run.group;
        case 'tags':
          return run.tags.length ? run.tags.join(', ') : null;
        case 'started':
          return run.startedAt;
        case 'ended':
          return run.endedAt;
        case 'heartbeat':
          return run.heartbeatAt;
        case 'duration':
          return run.durationS;
        case 'step':
          return run.step;
        case 'epoch':
          return run.epoch;
        case 'location':
          return run.location;
        default:
          return null;
      }
  }
}

/** All dynamic columns present in the given runs, grouped by kind, keys sorted. */
export function dynamicColumns(runs: readonly RunSummary[]): ColumnDef[] {
  const params = new Map<string, boolean>();
  const last = new Set<string>();
  const best = new Set<string>();
  const summary = new Map<string, boolean>();
  for (const r of runs) {
    for (const [k, v] of Object.entries(r.params)) params.set(k, (params.get(k) ?? true) && (v === null || typeof v === 'number'));
    for (const k of Object.keys(r.last)) last.add(k);
    for (const k of Object.keys(r.best)) best.add(k);
    for (const [k, v] of Object.entries(r.summary)) summary.set(k, (summary.get(k) ?? true) && (v === null || typeof v === 'number'));
  }
  const cols: ColumnDef[] = [];
  const sorted = <T>(it: Iterable<T>) => [...it].sort();
  for (const [k, num] of sorted(params.entries())) cols.push({ id: columnId('param', k), kind: 'param', key: k, label: k, numeric: num });
  for (const k of sorted(last)) cols.push({ id: columnId('last', k), kind: 'last', key: k, label: `last ${k}`, numeric: true });
  for (const k of sorted(best)) cols.push({ id: columnId('best', k), kind: 'best', key: k, label: `best ${k}`, numeric: true });
  for (const [k, num] of sorted(summary.entries())) cols.push({ id: columnId('summary', k), kind: 'summary', key: k, label: k, numeric: num });
  return cols;
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

export interface SortKey {
  col: string;
  dir: 'asc' | 'desc';
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function rank(v: Scalar): number {
  if (v === null || (typeof v === 'number' && Number.isNaN(v))) return 3;
  if (typeof v === 'number' || typeof v === 'boolean') return 0;
  return 1;
}

/** Compares two cell values in ascending order. Nulls are handled by the caller (always last). */
export function compareScalars(a: Scalar, b: Scalar): number {
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return Number(a) - Number(b);
  if (ra === 1) return collator.compare(String(a), String(b));
  return 0;
}

/** Multi-key sort. Nulls sort last regardless of direction. Stable. */
export function sortRuns(runs: readonly RunSummary[], keys: readonly SortKey[]): RunSummary[] {
  const out = runs.slice();
  if (keys.length === 0) return out;
  out.sort((x, y) => {
    for (const k of keys) {
      const a = columnValue(x, k.col);
      const b = columnValue(y, k.col);
      const an = a === null || (typeof a === 'number' && Number.isNaN(a));
      const bn = b === null || (typeof b === 'number' && Number.isNaN(b));
      if (an || bn) {
        if (an && bn) continue;
        return an ? 1 : -1;
      }
      const c = compareScalars(a as Scalar, b as Scalar);
      if (c !== 0) return k.dir === 'asc' ? c : -c;
    }
    return 0;
  });
  return out;
}

/** Click on a header: plain click sorts by that column only; shift-click adds/toggles a key. */
export function toggleSort(keys: readonly SortKey[], col: string, additive: boolean): SortKey[] {
  const existing = keys.find((k) => k.col === col);
  const nextDir: SortKey['dir'] = existing ? (existing.dir === 'asc' ? 'desc' : 'asc') : 'asc';
  if (!additive) return [{ col, dir: nextDir }];
  if (existing) return keys.map((k) => (k.col === col ? { col, dir: nextDir } : k));
  return [...keys, { col, dir: 'asc' }];
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

export interface ComparisonRow {
  label: string;
  values: Scalar[];
  differs: boolean;
}

function valueKey(v: Scalar | undefined): string {
  return v === undefined ? '\u0000missing' : JSON.stringify(v);
}

export function valuesDiffer(values: readonly (Scalar | undefined)[]): boolean {
  if (values.length < 2) return false;
  const first = valueKey(values[0]);
  return values.some((v) => valueKey(v) !== first);
}

/** Side-by-side tables for the selected runs. Presents data only; no ranking or winner. */
export function buildComparison(runs: readonly RunSummary[]): { params: ComparisonRow[]; metrics: ComparisonRow[] } {
  const paramKeys = [...new Set(runs.flatMap((r) => Object.keys(r.params)))].sort();
  const params = paramKeys.map((k) => {
    const raw = runs.map((r) => (k in r.params ? r.params[k] : undefined));
    return { label: k, values: raw.map((v) => (v === undefined ? null : v)), differs: valuesDiffer(raw) };
  });
  const metrics: ComparisonRow[] = [];
  const section = (kind: 'last' | 'best' | 'summary') => {
    const keys = [...new Set(runs.flatMap((r) => Object.keys(r[kind])))].sort();
    for (const k of keys) {
      const values = runs.map((r) => columnValue(r, columnId(kind, k)));
      metrics.push({ label: `${kind} ${k}`, values, differs: valuesDiffer(values) });
    }
  };
  section('last');
  section('best');
  section('summary');
  return { params, metrics };
}
