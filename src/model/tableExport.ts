// Builds the CSV export of the run table (for agents, pandas, spreadsheets). Pure: the host passes its
// own run data; only the run keys, column ids and view settings come from the webview.
import type { RunSummary, Scalar } from '../types';
import { FIXED_COLUMNS, OPTIONAL_FIXED_COLUMNS, columnValue, dynamicColumns, parseColumnId, type ColumnDef } from './run';

export interface TableExportRequest {
  runKeys: string[];
  columns: string[];
  view: {
    filters: { search: string; statuses: string[]; columns: Record<string, string> };
    sort: { col: string; dir: 'asc' | 'desc' }[];
    groupBy: string | null;
    maxRows: number | null;
  };
  counts: { total: number; filtered: number };
}

export interface TableExport {
  /** CSV header names, in order. */
  header: string[];
  /** One array of cells per run, in table order. */
  rows: Scalar[][];
}

const TIME_KEYS = new Set(['started', 'ended', 'heartbeat']);
/** Identity columns that every export starts with (so the table's own copies are skipped). */
const LEAD = ['id', 'name', 'status', 'group', 'tags', 'path'] as const;

/**
 * CSV header for a column. Logged values are prefixed by their group: `config.<key>` (params.yaml),
 * `run.start.<metric>` / `run.last.<metric>` / `run.best.<metric>` (metric history) and
 * `summary.<key>` (final values).
 */
export function csvHeader(c: Pick<ColumnDef, 'kind' | 'key'>): string {
  switch (c.kind) {
    case 'param':
      return `config.${c.key}`;
    case 'first':
      return `run.start.${c.key}`;
    case 'last':
      return `run.last.${c.key}`;
    case 'best':
      return `run.best.${c.key}`;
    case 'summary':
      return `summary.${c.key}`;
    case 'fixed':
      return c.key === 'duration' ? 'duration_s' : c.key;
  }
}

function exportValue(run: RunSummary, colId: string): Scalar {
  const v = columnValue(run, colId);
  const { kind, key } = parseColumnId(colId);
  if (kind === 'fixed' && TIME_KEYS.has(key) && typeof v === 'number') return new Date(v).toISOString();
  if (typeof v === 'number' && !Number.isFinite(v)) return null;
  return v;
}

export function buildTableExport(req: TableExportRequest, runs: ReadonlyMap<string, RunSummary>, runDirs: ReadonlyMap<string, string>): TableExport {
  const rowsRuns = req.runKeys.flatMap((k) => {
    const r = runs.get(k);
    return r ? [r] : [];
  });
  const known = new Map<string, ColumnDef>([...FIXED_COLUMNS, ...OPTIONAL_FIXED_COLUMNS, ...dynamicColumns(rowsRuns)].map((c) => [c.id, c]));
  const lead = new Set<string>(LEAD);
  const columns = req.columns.flatMap((id) => {
    const p = parseColumnId(id);
    const c = known.get(id) ?? (p.kind !== 'fixed' ? { id, kind: p.kind, key: p.key, label: id, numeric: false } : undefined);
    if (!c || (c.kind === 'fixed' && lead.has(c.key))) return [];
    return [c];
  });
  return {
    header: [...LEAD, ...columns.map(csvHeader)],
    rows: rowsRuns.map((r) => [r.id, r.name, r.displayStatus, r.group, r.tags.join(';'), runDirs.get(r.key) ?? r.key, ...columns.map((c) => exportValue(r, c.id))]),
  };
}

/** One CSV cell (RFC 4180 quoting). null is an empty cell. */
export function csvCell(v: Scalar): string {
  if (v === null) return '';
  const s = typeof v === 'number' ? String(v) : typeof v === 'boolean' ? (v ? 'true' : 'false') : v;
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function serializeTableCsv(e: TableExport): string {
  return [e.header, ...e.rows].map((row) => row.map(csvCell).join(',')).join('\n') + '\n';
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** File name for a timestamped export (UTC). */
export function exportFileName(d: Date): string {
  return `table-${stamp(d)}.csv`;
}

/** File name for a saved plot: `plot-<slug>-<UTC time>.png`, the slug made filesystem-safe. */
export function plotFileName(title: string, d: Date): string {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60)
      .replace(/-+$/, '') || 'chart';
  return `plot-${slug}-${stamp(d)}.png`;
}
