// Which runs a line chart draws when many are plotted: all of them, the best N for the chart's
// metric, or a median + interquartile band over all of them. Pure; the webview bundles it.

/** Line chart display: automatic, every run, the best N runs, or median + spread. */
export type LineMode = 'auto' | 'all' | 'top' | 'spread';
/** Which end of a metric is "best": automatic (from its name), lowest or highest. */
export type RankDir = 'auto' | 'min' | 'max';

/** Automatic mode draws every run up to this many lines; above it, the best N. */
export const AUTO_ALL_MAX = 15;
export const DEFAULT_TOP_N = 10;

/** Metric names where lower is better (losses, errors, distances, latencies). */
const LOWER_IS_BETTER = /loss|err|perplex|ppl|\bmse\b|\bmae\b|rmse|nll|\bwer\b|\bcer\b|\bfid\b|latency|distance|regret/i;

/** Guess of the better direction for a metric: lower for losses / errors, higher otherwise. */
export function metricDirection(metric: string): 'min' | 'max' {
  return LOWER_IS_BETTER.test(metric) ? 'min' : 'max';
}

export function resolveDirection(dir: RankDir, metric: string): 'min' | 'max' {
  return dir === 'auto' ? metricDirection(metric) : dir;
}

/** The last finite value of a series (its "final" value), or null. */
export function lastFinite(y: readonly (number | null)[]): number | null {
  for (let i = y.length - 1; i >= 0; i--) {
    const v = y[i];
    if (v !== null && v !== undefined && Number.isFinite(v)) return v;
  }
  return null;
}

/** The display mode actually used for `count` plotted runs. */
export function effectiveLineMode(mode: LineMode, count: number): Exclude<LineMode, 'auto'> {
  if (mode !== 'auto') return mode;
  return count > AUTO_ALL_MAX ? 'top' : 'all';
}

/**
 * Keys of the `n` best lines by final value (`dir`: lower or higher is better), best first.
 * Lines without a finite value rank last, in their given order.
 */
export function topLineKeys(lines: readonly { key: string; y: readonly (number | null)[] }[], n: number, dir: 'min' | 'max'): string[] {
  const ranked = lines.map((l, i) => ({ key: l.key, v: lastFinite(l.y), i }));
  ranked.sort((a, b) => {
    if (a.v === null || b.v === null) return a.v === null ? (b.v === null ? a.i - b.i : 1) : -1;
    return (dir === 'min' ? a.v - b.v : b.v - a.v) || a.i - b.i;
  });
  return ranked.slice(0, Math.max(0, n)).map((r) => r.key);
}

/** Valid "Top N" value (1–100) from user input; null when invalid. */
export function parseTopN(raw: string): number | null {
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 1 && n <= 100 ? n : null;
}
