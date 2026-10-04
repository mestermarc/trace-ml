// Filtering, differing-param detection, default column choice and selection helpers. Pure.
import type { DisplayStatus, RunSummary, Scalar } from '../types';
import { FIXED_COLUMNS, columnId, columnValue, dynamicColumns, valuesDiffer } from './run';

export interface ColumnFilter {
  test: (v: Scalar) => boolean;
  error: string | null;
}

const NUM = String.raw`[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?`;
const CMP_RE = new RegExp(String.raw`^(>=|<=|!=|==|=|>|<)\s*(${NUM})$`);
/** `= text` / `!= text`: exact text match (case-insensitive). */
const TEXT_EQ_RE = /^(==|=|!=)\s*(.+)$/;
/** `~ text` contains, `!~ text` does not contain (case-insensitive). */
const CONTAINS_RE = /^(!?)~\s*(.*)$/;
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
 *   text:     `= adamw` / `!= adamw` (exact), `~ adam` (contains), `!~ adam` (does not contain),
 *             a bare `substring` (contains) or `/regex/flags`
 * All text matching is case-insensitive. Null (missing) cells only match the empty expression.
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

  const contains = CONTAINS_RE.exec(e);
  if (contains) {
    const negate = contains[1] === '!';
    const needle = contains[2]!.trim().toLowerCase();
    if (!needle) return { test: () => true, error: 'enter the text to look for' };
    return { error: null, test: (v) => v !== null && String(v).toLowerCase().includes(needle) !== negate };
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

  const textEq = TEXT_EQ_RE.exec(e);
  if (textEq) {
    const negate = textEq[1] === '!=';
    const want = textEq[2]!.trim().toLowerCase();
    return { error: null, test: (v) => v !== null && (String(v).toLowerCase() === want) !== negate };
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

/** Operators offered by the filter builder. */
export type FilterOp = '=' | '!=' | '>' | '>=' | '<' | '<=' | 'between' | 'contains' | 'not contains' | 'regex';
export const NUMERIC_OPS: readonly FilterOp[] = ['=', '!=', '>', '>=', '<', '<=', 'between', 'contains', 'not contains'];
export const TEXT_OPS: readonly FilterOp[] = ['=', '!=', 'contains', 'not contains', 'regex'];

/** Builds the stored expression for an operator and a value (the inverse of describeFilter). */
export function buildFilterExpr(op: FilterOp, value: string): string {
  const v = value.trim();
  switch (op) {
    case 'contains':
      return `~ ${v}`;
    case 'not contains':
      return `!~ ${v}`;
    case 'regex':
      return /^\/.*\/[a-z]*$/.test(v) ? v : `/${v}/`;
    case 'between': {
      const m = /^(\S+)\s*(?:\.\.|,|-|\s)\s*(\S+)$/.exec(v);
      return m ? `${m[1]}..${m[2]}` : v;
    }
    default:
      return `${op} ${v}`;
  }
}

/** Human-readable form of an expression, for chips and lists: `~ adam` -> `contains adam`. */
export function describeFilter(expr: string): string {
  const e = expr.trim();
  const c = CONTAINS_RE.exec(e);
  if (c && !/^\/.*\/[a-z]*$/.test(e)) return `${c[1] ? 'not contains' : 'contains'} ${c[2]!.trim()}`;
  if (RANGE_RE.test(e)) return `between ${e.replace(/\s*\.\.\s*/, ' and ')}`;
  if (CMP_RE.test(e) || TEXT_EQ_RE.test(e) || /^\/.*\/[a-z]*$/.test(e)) return e.replace(/^==/, '=');
  return NUM_RE.test(e) ? `= ${e}` : `contains ${e}`;
}

/**
 * Value suggestions for a column: its distinct non-empty values among the runs, most frequent
 * first (ties in natural order), formatted as they would be typed.
 */
export function suggestValues(runs: readonly RunSummary[], colId: string, limit = 50): string[] {
  const counts = new Map<string, number>();
  for (const r of runs) {
    const v = columnValue(r, colId);
    if (v === null || v === '' || (typeof v === 'number' && !Number.isFinite(v))) continue;
    for (const part of colId === 'tags' ? r.tags : [String(v)]) counts.set(part, (counts.get(part) ?? 0) + 1);
  }
  const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return [...counts]
    .sort((a, b) => b[1] - a[1] || natural.compare(a[0], b[0]))
    .slice(0, limit)
    .map(([v]) => v);
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

/** The Max rows limit, applied to already filtered and sorted runs; null = no limit. */
export function limitRows<T>(rows: readonly T[], max: number | null): T[] {
  return max === null || max >= rows.length ? rows.slice() : rows.slice(0, Math.max(0, max));
}

/** Upper bound of the Max rows input (larger tables: choose All). */
export const MAX_ROWS_LIMIT = 1000;

/** Max rows input text -> limit: a whole number 1..MAX_ROWS_LIMIT, or null for "All". undefined = invalid. */
export function parseMaxRows(text: string): number | null | undefined {
  const t = text.trim().toLowerCase();
  if (t === '' || t === 'all') return null;
  if (!/^\d+$/.test(t)) return undefined;
  const n = Number(t);
  return n >= 1 && n <= MAX_ROWS_LIMIT ? n : undefined;
}

/** Moves column `id` before (or after) column `target` in an ordered id list. */
export function moveColumn(ids: readonly string[], id: string, target: string, after = false): string[] {
  if (id === target || !ids.includes(id) || !ids.includes(target)) return ids.slice();
  const out = ids.filter((x) => x !== id);
  const i = out.indexOf(target);
  out.splice(after ? i + 1 : i, 0, id);
  return out;
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
