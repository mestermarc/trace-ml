// Series extraction, downsampling and smoothing. Pure functions; the webview bundles parts of this.
import type { SeriesPayload } from '../types';

/** Minimal view of the metric history needed to extract a series (see parsers/metricsJsonl.ts). */
export interface HistoryLike {
  step: number[];
  epoch: (number | null)[];
  time: (number | null)[];
  metrics: Map<string, { rows: number[]; values: (number | null)[] }>;
  version: number;
}

/**
 * Picks point indices so that at most `maxPoints` remain, using min/max-preserving buckets:
 * the first and last points are always kept, and every bucket keeps its minimum, its maximum
 * and (if present) its first null so gaps survive. Never "every Nth point".
 */
export function downsampleIndices(y: readonly (number | null)[], maxPoints: number): number[] {
  const n = y.length;
  if (n <= maxPoints || n <= 2) return Array.from({ length: n }, (_, i) => i);
  const max = Math.max(3, Math.floor(maxPoints));
  // Each bucket keeps up to 2 points (min, max), or 3 when the series has gaps to preserve.
  const hasNull = y.some((v) => v === null || v === undefined);
  const buckets = Math.max(1, Math.floor((max - 2) / (hasNull ? 3 : 2)));
  const interior = n - 2;
  const out: number[] = [0];
  for (let b = 0; b < buckets; b++) {
    const start = 1 + Math.floor((b * interior) / buckets);
    const end = 1 + Math.floor(((b + 1) * interior) / buckets);
    let minI = -1;
    let maxI = -1;
    let nullI = -1;
    for (let i = start; i < end; i++) {
      const v = y[i];
      if (v === null || v === undefined) {
        if (nullI < 0) nullI = i;
        continue;
      }
      if (minI < 0 || v < (y[minI] as number)) minI = i;
      if (maxI < 0 || v > (y[maxI] as number)) maxI = i;
    }
    const picked = [minI, maxI, nullI].filter((i) => i >= 0).sort((a, b) => a - b);
    for (const i of picked) if (out[out.length - 1] !== i) out.push(i);
  }
  if (out[out.length - 1] !== n - 1) out.push(n - 1);
  return out;
}

/** Builds the (possibly downsampled) payload for one metric of one run. */
export function extractSeries(
  history: HistoryLike,
  runKey: string,
  metric: string,
  startedAtMs: number | null,
  maxPoints: number,
): SeriesPayload {
  const col = history.metrics.get(metric);
  const rows = col?.rows ?? [];
  const values = col?.values ?? [];
  const firstTime = history.time.find((t) => t !== null) ?? null;
  const t0 = startedAtMs !== null ? startedAtMs / 1000 : firstTime;
  const keep = downsampleIndices(values, maxPoints);
  const step: number[] = [];
  const epoch: (number | null)[] = [];
  const wall: (number | null)[] = [];
  const y: (number | null)[] = [];
  for (const k of keep) {
    const r = rows[k]!;
    step.push(history.step[r]!);
    epoch.push(history.epoch[r] ?? null);
    const t = history.time[r] ?? null;
    wall.push(t !== null && t0 !== null ? t - t0 : null);
    y.push(values[k] ?? null);
  }
  return { runKey, metric, step, epoch, wall, y, total: values.length, version: history.version };
}

export type XMode = 'step' | 'epoch' | 'wall';

/**
 * Line-plot arrays for one run and x mode: rows without an x value are dropped, x is sorted and
 * de-duplicated (last value wins), and non-positive values become gaps on a log-y axis.
 */
export function seriesXY(p: SeriesPayload, xMode: XMode, logY: boolean): { x: number[]; y: (number | null)[] } {
  const xs = p[xMode];
  const pts: [number, number | null][] = [];
  for (let i = 0; i < p.y.length; i++) {
    const x = xs[i];
    if (x === null || x === undefined) continue;
    let y = p.y[i] ?? null;
    if (logY && y !== null && y <= 0) y = null;
    pts.push([x, y]);
  }
  let sorted = true;
  for (let i = 1; i < pts.length; i++) if (pts[i]![0] < pts[i - 1]![0]) sorted = false;
  if (!sorted) pts.sort((a, b) => a[0] - b[0]);
  const x: number[] = [];
  const y: (number | null)[] = [];
  for (const [px, py] of pts) {
    if (x.length && x[x.length - 1] === px) y[y.length - 1] = py;
    else {
      x.push(px);
      y.push(py);
    }
  }
  return { x, y };
}

/**
 * Debiased exponential moving average (TensorBoard-style). `alpha` in [0, 0.99]; 0 = no smoothing.
 * Nulls stay null (gaps) and do not affect the running average.
 */
export function emaSmooth(y: readonly (number | null)[], alpha: number): (number | null)[] {
  if (alpha <= 0) return y.slice();
  const a = Math.min(alpha, 0.99);
  let last = 0;
  let weight = 0;
  return y.map((v) => {
    if (v === null || !Number.isFinite(v)) return null;
    last = last * a + (1 - a) * v;
    weight = weight * a + (1 - a);
    return last / weight;
  });
}
