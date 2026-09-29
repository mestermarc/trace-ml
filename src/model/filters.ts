// Filtering, differing-param detection, default column choice and selection helpers. Pure.
import type { DisplayStatus, RunSummary, Scalar } from '../types';
import { FIXED_COLUMNS, columnId, columnValue, dynamicColumns, valuesDiffer } from './run';

export interface ColumnFilter {
  test: (v: Scalar) => boolean;
  error: string | null;
}

const NUM = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`;
const CMP_RE = new RegExp(String.raw`^(>=|<=|!=|==|=|>|<)\s*(${NUM})$`);
const RANGE_RE = new RegExp(String.raw`^(${NUM})\s*\.\.\s*(${NUM})$`);
const NUM_RE = new RegExp(String.raw`^${NUM}$`);

const ALL: ColumnFilter = { test: () => true, error: null };

function asNumber(v: Scalar): number | null {
  if (typeof v === 'number') return Number.isNaN(v) ? null : v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return null;
}

/**
 * Parses a per-column filter expression.
 *   numeric:  `> 0.8`, `<= 1e-3`, `0.1..0.5`, `!= 0`, `= 64`, or a bare number (equality)
 *   string:   `substring` (case-insensitive) or `/regex/flags`
 * Null cells only match the empty expression.
 */
export function parseColumnFilter(expr: string): ColumnFilter {
  const e = expr.trim();
  if (e === '') return ALL;

  const re = /^\/(.*)\/([a-z]*)$/.exec(e);
  if (re) {
    try {
      const rx = new RegExp(re[1]!, re[2]!.includes('i') ? re[2] : re[2] + 'i');
      return { test: (v) => v !== null && rx.test(String(v)), error: null };
    } catch (err) {
      return { test: () => true, error: `invalid regex: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  const cmp = CMP_RE.exec(e);
  if (cmp) {
    const op = cmp[1]!;
    const x = Number(cmp[2]);
    return {
      error: null,
      test: (v) => {
        const n = asNumber(v);
        if (n === null) return false;
        switch (op) {
          case '>':
            return n > x;
          case '>=':
            return n >= x;
          case '<':
            return n < x;
          case '<=':
            return n <= x;
          case '!=':
            return n !== x;
          default:
            return n === x;
        }
      },
    };
  }

  const range = RANGE_RE.exec(e);
  if (range) {
    const a = Number(range[1]);
    const b = Number(range[2]);
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    return {
      error: null,
      test: (v) => {
        const n = asNumber(v);
        return n !== null && n >= lo && n <= hi;
      },
    };
  }

  const needle = e.toLowerCase();
  const asNum = NUM_RE.test(e) ? Number(e) : null;
  return {
    error: null,
    test: (v) => {
      if (v === null) return false;
      if (asNum !== null && typeof v === 'number') return v === asNum;
      return String(v).toLowerCase().includes(needle);
    },
  };
}

/** Free-text search over id / name / group / tags. Every whitespace-separated term must match. */
export function matchesSearch(run: RunSummary, text: string): boolean {
  const terms = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const hay = [run.id, run.name, run.group ?? '', ...run.tags].join('\u0001').toLowerCase();
  return terms.every((t) => hay.includes(t));
}

export interface FilterState {
  search: string;
  /** Empty = all statuses. */
  statuses: DisplayStatus[];
  /** Column id -> expression. */
  columns: Record<string, string>;
}

export function filterRuns(runs: readonly RunSummary[], f: FilterState): RunSummary[] {
  const statuses = new Set(f.statuses);
  const colFilters = Object.entries(f.columns)
    .filter(([, expr]) => expr.trim() !== '')
    .map(([col, expr]) => ({ col, filter: parseColumnFilter(expr) }))
    .filter((c) => c.filter.error === null);
  return runs.filter(
    (r) =>
      (statuses.size === 0 || statuses.has(r.displayStatus)) &&
      matchesSearch(r, f.search) &&
      colFilters.every((c) => c.filter.test(columnValue(r, c.col))),
  );
}

/** Param keys whose values are not identical across the given runs (a missing key counts as a value). */
export function differingParams(runs: readonly RunSummary[]): string[] {
  const keys = [...new Set(runs.flatMap((r) => Object.keys(r.params)))].sort();
  return keys.filter((k) => valuesDiffer(runs.map((r) => (k in r.params ? r.params[k] : undefined))));
}

export const MAX_DEFAULT_PARAMS = 6;

/**
 * Default visible columns: fixed columns, all best metrics, all summary metrics and
 * up to six parameters that differ between the (visible) runs.
 */
export function defaultVisibleColumns(runs: readonly RunSummary[]): string[] {
  const dyn = dynamicColumns(runs);
  const diff = differingParams(runs).slice(0, MAX_DEFAULT_PARAMS);
  return [
    ...FIXED_COLUMNS.map((c) => c.id),
    ...diff.map((k) => columnId('param', k)),
    ...dyn.filter((c) => c.kind === 'best').map((c) => c.id),
    ...dyn.filter((c) => c.kind === 'summary').map((c) => c.id),
  ];
}

/** "Select filtered": union of the current selection and the filtered runs. */
export function selectFiltered(selected: ReadonlySet<string>, filtered: readonly RunSummary[]): Set<string> {
  const out = new Set(selected);
  for (const r of filtered) out.add(r.key);
  return out;
}

/** Drops selected keys whose runs no longer exist (deleted runs). */
export function pruneSelection(selected: ReadonlySet<string>, existing: ReadonlySet<string>): Set<string> {
  return new Set([...selected].filter((k) => existing.has(k)));
}
