// Chart data as plain CSV ("Save data"), so a chart can be handed to an agent or loaded in pandas.
// One flat table per chart, named like the table export (`config.*`, `run.best.*`, `summary.*`, ...).
// Pure; shared by the webview (scatter / box / bar) and the host (line charts, full history).
import type { Scalar } from '../types';
import { groupFieldParts, type BarData, type BoxData, type ScatterData } from './analysis';
import type { MetricsHistory } from '../parsers/metricsJsonl';
import { groupMeanSeries, type GroupPoint } from './groupAgg';
import { extractSeries } from './metricSeries';
import { parseColumnId } from './run';
import { csvHeader, serializeTableCsv } from './tableExport';

/** CSV header name of a field (column id), e.g. `best:val/auc` -> `run.best.val/auc`. */
export function fieldHeader(colId: string): string {
  const parts = groupFieldParts(colId);
  // combined grouping field: config.data+config.optim (values are joined with " · ")
  if (parts.length > 1) return parts.map(fieldHeader).join('+');
  return csvHeader(parseColumnId(colId));
}

/** One row per plotted run: run, path, x, y (+ size and colour group when used). */
export function scatterCsv(d: ScatterData, x: string, y: string, size: string | null, group: string | null): string {
  const header = ['run', 'path', fieldHeader(x), fieldHeader(y), ...(size ? [fieldHeader(size)] : []), ...(group ? [`group:${fieldHeader(group)}`] : [])];
  const rows: Scalar[][] = d.points.map((p) => [p.name, p.key, p.x, p.y, ...(size ? [p.size] : []), ...(group ? [p.group] : [])]);
  return serializeTableCsv({ header, rows });
}

/** One row per run and box: the group (box), the run and its value. Quartiles follow from the values. */
export function boxCsv(d: BoxData, field: string, group: string | null): string {
  const header = [group ? `group:${fieldHeader(group)}` : 'group', 'run', 'path', fieldHeader(field)];
  const rows: Scalar[][] = d.boxes.flatMap((b) => b.values.map((v) => [b.label, v.name, v.key, v.value]));
  return serializeTableCsv({ header, rows });
}

/** Runs mode: one row per bar (run, path, group?, value). Groups mode: group, n, mean, min, max. */
export function barCsv(d: BarData, field: string, group: string | null, mode: 'runs' | 'groups'): string {
  const value = fieldHeader(field);
  if (mode === 'groups') {
    const header = [group ? `group:${fieldHeader(group)}` : 'group', 'n', `mean ${value}`, `min ${value}`, `max ${value}`];
    return serializeTableCsv({ header, rows: d.bars.map((b) => [b.label, b.n ?? null, b.value, b.min ?? null, b.max ?? null]) });
  }
  const header = ['run', 'path', ...(group ? [`group:${fieldHeader(group)}`] : []), value];
  return serializeTableCsv({ header, rows: d.bars.map((b) => [b.label, b.key, ...(group ? [b.group] : []), b.value]) });
}

export interface LineRun {
  name: string;
  path: string;
  history: MetricsHistory;
  /** started_at (epoch ms), for the wall-clock column; null when unknown. */
  startedAt: number | null;
}

/**
 * Long format, one row per logged value of `metric`: run, path, step, epoch, time_s (seconds since
 * the run started), value. Rows without the metric are skipped; null values are kept (gaps).
 */
export function lineCsv(metric: string, runs: readonly LineRun[]): { csv: string; rows: number } {
  const rows: Scalar[][] = [];
  for (const r of runs) {
    const col = r.history.metrics.get(metric);
    if (!col) continue;
    const t0 = r.startedAt !== null ? r.startedAt / 1000 : (r.history.time.find((t) => t !== null) ?? null);
    col.rows.forEach((i, j) => {
      const t = r.history.time[i] ?? null;
      rows.push([r.name, r.path, r.history.step[i]!, r.history.epoch[i] ?? null, t !== null && t0 !== null ? Math.round((t - t0) * 1000) / 1000 : null, col.values[j]!]);
    });
  }
  return { csv: serializeTableCsv({ header: ['run', 'path', 'step', 'epoch', 'time_s', metric], rows }), rows: rows.length };
}

/**
 * Line chart by groups: one row per group and step with the group mean of `metric` and the number
 * of runs behind it (full history, same matching as the plotted group curves).
 */
export function lineGroupCsv(metric: string, runs: readonly (LineRun & { group: string })[]): { csv: string; rows: number } {
  const groups = new Map<string, LineRun[]>();
  for (const r of runs) groups.set(r.group, [...(groups.get(r.group) ?? []), r]);
  const rows: Scalar[][] = [];
  for (const [label, rs] of groups) {
    const m = groupMeanSeries(rs.map((r) => extractSeries(r.history, r.path, metric, r.startedAt, Number.POSITIVE_INFINITY)), 'step', false);
    m.x.forEach((step, i) => rows.push([label, step, m.y[i]!, m.n[i]!]));
  }
  return { csv: serializeTableCsv({ header: ['group', 'step', `mean ${metric}`, 'n_runs'], rows }), rows: rows.length };
}

/** Scatter by groups: one row per group with the mean (and standard deviation) of x and y. */
export function scatterGroupCsv(points: readonly GroupPoint[], x: string, y: string, group: string | null): string {
  const X = fieldHeader(x);
  const Y = fieldHeader(y);
  const header = [group ? `group:${fieldHeader(group)}` : 'group', 'n', `mean ${X}`, `std ${X}`, `mean ${Y}`, `std ${Y}`];
  return serializeTableCsv({ header, rows: points.map((p) => [p.group, p.n, p.x, p.sx, p.y, p.sy]) });
}
