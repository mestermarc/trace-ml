// Run-level analysis: grouping, scatter and box-plot data. Pure; uses only already-loaded run
// summaries (run.json / params.yaml / metrics.json), never metrics.jsonl histories.
import type { RunSummary, Scalar } from '../types';
import { columnValue, compareScalars } from './run';

export const NONE_GROUP = '(none)';

/** Numeric value of a field, or null for missing / null / NaN / non-numeric values. */
export function numericValue(run: RunSummary, field: string): number | null {
  const v = columnValue(run, field);
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Group label of a run for a grouping field ("(none)" when missing). */
export function groupLabel(run: RunSummary, field: string): string {
  return groupLabelOf(columnValue(run, field));
}

function groupLabelOf(v: Scalar): string {
  if (v === null || v === '' || (typeof v === 'number' && Number.isNaN(v))) return NONE_GROUP;
  return String(v);
}

export interface RunGroup {
  /** Display label; also the identity of the group. */
  label: string;
  /** Representative raw value used for ordering (null for the "(none)" group). */
  value: Scalar;
  runs: RunSummary[];
}

/**
 * Groups runs by the value of a field (group, tags, status, a parameter, ...).
 * Groups are ordered by value (numbers numerically, strings naturally), "(none)" last.
 * Run order inside each group is preserved, so sorting applies within groups.
 */
export function groupRuns(runs: readonly RunSummary[], field: string): RunGroup[] {
  const groups = new Map<string, RunGroup>();
  for (const r of runs) {
    const v = columnValue(r, field);
    const label = groupLabelOf(v);
    let g = groups.get(label);
    if (!g) {
      g = { label, value: label === NONE_GROUP ? null : v, runs: [] };
      groups.set(label, g);
    }
    g.runs.push(r);
  }
  return [...groups.values()].sort((a, b) => {
    if (a.value === null || b.value === null) return a.value === null ? (b.value === null ? 0 : 1) : -1;
    return compareScalars(a.value, b.value);
  });
}

// ---------------------------------------------------------------------------
// Scatter
// ---------------------------------------------------------------------------

export interface ScatterPoint {
  key: string;
  name: string;
  x: number;
  y: number;
  size: number | null;
  group: string | null;
}

export interface ScatterData {
  points: ScatterPoint[];
  /** Runs left out because X or Y is missing / non-numeric. */
  excluded: number;
  /** Group labels in display order (empty when not grouped). */
  groups: string[];
}

export function scatterData(
  runs: readonly RunSummary[],
  xField: string,
  yField: string,
  opts: { sizeField?: string | null; groupField?: string | null } = {},
): ScatterData {
  const points: ScatterPoint[] = [];
  let excluded = 0;
  for (const r of runs) {
    const x = numericValue(r, xField);
    const y = numericValue(r, yField);
    if (x === null || y === null) {
      excluded++;
      continue;
    }
    points.push({
      key: r.key,
      name: r.name,
      x,
      y,
      size: opts.sizeField ? numericValue(r, opts.sizeField) : null,
      group: opts.groupField ? groupLabelOf(columnValue(r, opts.groupField)) : null,
    });
  }
  const plotted = new Set(points.map((p) => p.key));
  const groups = opts.groupField ? groupRuns(runs.filter((r) => plotted.has(r.key)), opts.groupField).map((g) => g.label) : [];
  return { points, excluded, groups };
}

// ---------------------------------------------------------------------------
// Box plot
// ---------------------------------------------------------------------------

export interface BoxValue {
  key: string;
  name: string;
  value: number;
}

export interface BoxStats {
  label: string;
  n: number;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  /** Whisker ends: most extreme values within 1.5 IQR of the box. */
  lo: number;
  hi: number;
  outliers: BoxValue[];
  values: BoxValue[];
}

export interface BoxData {
  boxes: BoxStats[];
  /** Runs left out because the field is missing / non-numeric. */
  excluded: number;
}

/** Linear-interpolation quantile (type 7) of an ascending array. */
export function quantile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * p;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

export function boxStats(label: string, values: readonly BoxValue[]): BoxStats {
  const vs = [...values].sort((a, b) => a.value - b.value);
  const nums = vs.map((v) => v.value);
  const q1 = quantile(nums, 0.25);
  const median = quantile(nums, 0.5);
  const q3 = quantile(nums, 0.75);
  const iqr = q3 - q1;
  const loFence = q1 - 1.5 * iqr;
  const hiFence = q3 + 1.5 * iqr;
  const inside = nums.filter((v) => v >= loFence && v <= hiFence);
  return {
    label,
    n: nums.length,
    min: nums[0]!,
    q1,
    median,
    q3,
    max: nums[nums.length - 1]!,
    lo: inside.length ? inside[0]! : q1,
    hi: inside.length ? inside[inside.length - 1]! : q3,
    outliers: vs.filter((v) => v.value < loFence || v.value > hiFence),
    values: vs,
  };
}

/** One box per group (or a single "all runs" box when groupField is null). Empty groups are dropped. */
export function boxData(runs: readonly RunSummary[], field: string, groupField: string | null): BoxData {
  let excluded = 0;
  const groups = groupField ? groupRuns(runs, groupField) : [{ label: 'all runs', value: null, runs: [...runs] }];
  const boxes: BoxStats[] = [];
  for (const g of groups) {
    const values: BoxValue[] = [];
    for (const r of g.runs) {
      const v = numericValue(r, field);
      if (v === null) excluded++;
      else values.push({ key: r.key, name: r.name, value: v });
    }
    if (values.length) boxes.push(boxStats(g.label, values));
  }
  return { boxes, excluded };
}

// ---------------------------------------------------------------------------
// Axis helpers (shared by the SVG charts)
// ---------------------------------------------------------------------------

/** "Nice" tick values covering [min, max] (linear scale). */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) {
    const d = Math.abs(min) || 1;
    min -= d * 0.5;
    max += d * 0.5;
  }
  // Smallest "nice" step (1, 2, 2.5, 5 x 10^k) giving at most count + 1 intervals.
  const range = max - min;
  const mag = 10 ** Math.floor(Math.log10(range / Math.max(1, count)));
  const step = [1, 2, 2.5, 5, 10, 20].map((m) => m * mag).find((st) => range / st <= count + 1) ?? 20 * mag;
  const start = Math.ceil(min / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let t = start; t <= max + step * 1e-9; t += step) ticks.push(Number(t.toPrecision(12)));
  return ticks;
}

/** Powers of ten covering [min, max] (log scale); both must be > 0. */
export function logTicks(min: number, max: number): number[] {
  if (!(min > 0) || !(max > 0)) return [];
  const collect = (mults: number[]) => {
    const out: number[] = [];
    for (let e = Math.floor(Math.log10(min)); e <= Math.ceil(Math.log10(max)); e++) {
      for (const m of mults) {
        const t = Number((m * 10 ** e).toPrecision(12));
        if (t >= min * 0.999 && t <= max * 1.001) out.push(t);
      }
    }
    return out;
  };
  const decades = collect([1]);
  // Narrow ranges (< ~2 decades) also get 2x and 5x ticks.
  return decades.length >= 3 ? decades : collect([1, 2, 5]);
}
