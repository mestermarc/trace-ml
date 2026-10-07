// Group-level aggregation ("Plot by groups" and group statistics in the table): mean, spread and
// count per group. Pure; works on the run summaries and series the webview already has.
import type { RunSummary, SeriesPayload } from '../types';
import type { XMode } from './metricSeries';
import { groupRuns, numericValue, type ScatterData, type ScatterPoint } from './analysis';
import type { ColumnDef } from './run';

export interface Stats {
  n: number;
  mean: number;
  min: number;
  max: number;
  /** Sample standard deviation (0 for a single value). */
  std: number;
}

/** Mean, min, max and sample standard deviation; null when there are no values. */
export function stats(values: readonly number[]): Stats | null {
  const v = values.filter((x) => Number.isFinite(x));
  if (!v.length) return null;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const std = v.length > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1)) : 0;
  return { n: v.length, mean, min: Math.min(...v), max: Math.max(...v), std };
}

/** Fixed numeric columns where a group mean means something (not timestamps). */
const STAT_FIXED = new Set(['duration', 'step', 'epoch']);

/** Whether a table column gets a group statistic: numeric logged values, duration, step, epoch. */
export function isStatColumn(c: ColumnDef): boolean {
  return c.numeric && (c.kind !== 'fixed' || STAT_FIXED.has(c.key));
}

/** Per column: statistics of the group's runs (null when no run has a number there). */
export function groupColumnStats(runs: readonly RunSummary[], cols: readonly ColumnDef[]): Map<string, Stats | null> {
  const out = new Map<string, Stats | null>();
  for (const c of cols) {
    if (!isStatColumn(c)) continue;
    out.set(c.id, stats(runs.flatMap((r) => (numericValue(r, c.id) === null ? [] : [numericValue(r, c.id)!]))));
  }
  return out;
}

export interface MeanSeries {
  x: number[];
  y: (number | null)[];
  /** Number of runs with a value at each point. */
  n: number[];
}

/**
 * The group-mean curve of several runs' series for one metric. Points are matched by step (by
 * epoch in epoch mode); in wall-time mode the x of a step is the mean wall time of the runs there.
 * Each run counts once per step (its last value, as in the single-run curves). A step where no
 * run has a value is a gap. With logY, non-positive means become gaps.
 */
export function groupMeanSeries(series: readonly SeriesPayload[], xMode: XMode, logY: boolean): MeanSeries {
  const acc = new Map<number, { sum: number; n: number; wall: number; wn: number }>();
  for (const p of series) {
    const perRun = new Map<number, { y: number | null; wall: number | null }>();
    for (let i = 0; i < p.y.length; i++) {
      const key = xMode === 'epoch' ? p.epoch[i] : p.step[i];
      if (key === null || key === undefined || !Number.isFinite(key)) continue;
      perRun.set(key, { y: p.y[i] ?? null, wall: p.wall[i] ?? null });
    }
    for (const [key, v] of perRun) {
      let a = acc.get(key);
      if (!a) acc.set(key, (a = { sum: 0, n: 0, wall: 0, wn: 0 }));
      if (v.y !== null && Number.isFinite(v.y)) {
        a.sum += v.y;
        a.n++;
      }
      if (v.wall !== null && Number.isFinite(v.wall)) {
        a.wall += v.wall;
        a.wn++;
      }
    }
  }
  const pts = [...acc].flatMap(([key, a]) => {
    const x = xMode === 'wall' ? (a.wn ? a.wall / a.wn : null) : key;
    if (x === null) return [];
    let y: number | null = a.n ? a.sum / a.n : null;
    if (logY && y !== null && y <= 0) y = null;
    return [{ x, y, n: a.n }];
  });
  pts.sort((p, q) => p.x - q.x);
  return { x: pts.map((p) => p.x), y: pts.map((p) => p.y), n: pts.map((p) => p.n) };
}

export interface GroupPoint extends ScatterPoint {
  n: number;
  sx: number;
  sy: number;
}

/** Scatter by groups: one point per group at (mean x, mean y), with the run count and spread. */
export function scatterGroupMeans(data: ScatterData): GroupPoint[] {
  const by = new Map<string, ScatterPoint[]>();
  for (const p of data.points) {
    const g = p.group ?? 'all runs';
    by.set(g, [...(by.get(g) ?? []), p]);
  }
  const order = data.groups.length ? data.groups : [...by.keys()];
  return order.flatMap((label) => {
    const pts = by.get(label);
    if (!pts?.length) return [];
    const sx = stats(pts.map((p) => p.x))!;
    const sy = stats(pts.map((p) => p.y))!;
    return [{ key: `group:${label}`, name: label, x: sx.mean, y: sy.mean, size: null, group: label, n: pts.length, sx: sx.std, sy: sy.std }];
  });
}

/** Runs grouped by a field, in display order (convenience for the plots). */
export function plotGroups(runs: readonly RunSummary[], field: string): { label: string; runs: RunSummary[] }[] {
  return groupRuns(runs, field).map((g) => ({ label: g.label, runs: g.runs }));
}
