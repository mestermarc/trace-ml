// Typed message protocol between the extension host and the webview.
import type { HiddenRun } from './model/hiddenRuns';
import { MAX_PNG_BYTES } from './model/png';
import type { TableExportRequest } from './model/tableExport';
import { RUN_FILES, type RunDetail, type RunFileName, type RunSummary, type SeriesPayload, type ViewConfig } from './types';

export type HostToWebview =
  /** `scanned` is false when no scan has completed yet (runs may be empty only because discovery is pending). */
  | { type: 'runsSnapshot'; runs: RunSummary[]; refreshedAt: number; config: ViewConfig; roots: string[]; scanned: boolean }
  | { type: 'runsPatch'; upserts: RunSummary[]; removed: string[]; refreshedAt: number; roots?: string[] }
  | { type: 'series'; series: SeriesPayload[] }
  | { type: 'runDetail'; detail: RunDetail }
  | { type: 'error'; message: string }
  /** Result of an export: where the CSV was written. */
  | { type: 'exported'; path: string; latestPath: string; rows: number; exportedAt: string }
  /** Runs deleted from TraceML (hidden; their folders are untouched). Sent on start and on every change. */
  | { type: 'hiddenRuns'; runs: HiddenRun[] }
  /** A plot was saved as PNG. */
  | { type: 'plotSaved'; path: string; width: number; height: number }
  /** Show this run (from the activity-bar view): Runs view + inspector. */
  | { type: 'focusRun'; runKey: string }
  /** A chart's data was saved as CSV. */
  | { type: 'plotDataSaved'; path: string; rows: number }
  /** A dashboard snapshot was written: its path, run count, runs with charts and size. */
  | { type: 'dashboardExported'; path: string; runs: number; chartRuns: number; bytes: number };

export type WebviewToHost =
  | { type: 'ready' }
  /** Declares the full set of series the webview currently plots (replaces the previous request). */
  | { type: 'requestSeries'; runKeys: string[]; metrics: string[] }
  | { type: 'requestDetail'; runKey: string }
  /** Copy a run's folder path to the clipboard. */
  | { type: 'copyRunPath'; runKey: string }
  | { type: 'openFile'; runKey: string; file: RunFileName }
  | { type: 'refreshNow' }
  /** Opens the VS Code settings UI filtered to TraceML settings. */
  | { type: 'openSettings' }
  /** UI state (plots, selection, filters...) to remember for the next time the panel opens. */
  | { type: 'saveState'; state: Record<string, unknown> }
  /** Export the table rows currently shown (the host rebuilds the rows from its own data). */
  | { type: 'exportTable'; request: ExportRequest }
  /** Copy the last export path to the clipboard / open the last export read-only. */
  | { type: 'copyExportPath' }
  | { type: 'openExport' }
  /** Delete runs from TraceML (hide them; files are not touched) / restore them. */
  | { type: 'hideRuns'; runKeys: string[] }
  | { type: 'unhideRuns'; runKeys: string[] }
  /** Save a rendered plot (base64 PNG) into the cache folder; `title` names the file. */
  | { type: 'savePlot'; title: string; data: string }
  /** Save a scatter / box / bar chart's data (CSV built by the webview from run-level values). */
  | { type: 'savePlotData'; title: string; csv: string }
  /** Save a line chart's data: the host writes the full history of `metric` for these runs. */
  | { type: 'saveLineData'; metric: string; runKeys: string[]; groups?: Record<string, string> }
  | { type: 'copyPlotPath' }
  | { type: 'openPlot' }
  /**
   * Export a self-contained HTML dashboard: `runKeys` are the runs in the table (filters applied),
   * `chartKeys` the plotted runs whose metric histories and details are included, `state` the view.
   */
  | { type: 'exportDashboard'; runKeys: string[]; chartKeys: string[]; state: Record<string, unknown> }
  | { type: 'copyDashboardPath' }
  | { type: 'openDashboard' };

/** What the table currently shows; the host turns this into the export snapshot. */
export type ExportRequest = TableExportRequest;

const MAX_EXPORT_RUNS = 100_000;
const MAX_EXPORT_COLUMNS = 5_000;

function isStringRecord(v: unknown): v is Record<string, string> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'string');
}

/** Validates an export request coming from the webview (shape and size only). */
export function parseExportRequest(r: unknown): ExportRequest | null {
  if (typeof r !== 'object' || r === null) return null;
  const q = r as Record<string, unknown>;
  const view = q.view as Record<string, unknown> | undefined;
  const counts = q.counts as Record<string, unknown> | undefined;
  const filters = view?.filters as Record<string, unknown> | undefined;
  if (!isStringArray(q.runKeys) || q.runKeys.length > MAX_EXPORT_RUNS) return null;
  if (!isStringArray(q.columns) || q.columns.length > MAX_EXPORT_COLUMNS) return null;
  if (!view || !filters || typeof filters.search !== 'string' || !isStringArray(filters.statuses) || !isStringRecord(filters.columns)) return null;
  if (!Array.isArray(view.sort) || !view.sort.every((k) => typeof k?.col === 'string' && (k.dir === 'asc' || k.dir === 'desc'))) return null;
  if (!(view.groupBy === null || typeof view.groupBy === 'string')) return null;
  if (!(view.maxRows === null || (typeof view.maxRows === 'number' && Number.isInteger(view.maxRows) && view.maxRows > 0))) return null;
  if (!counts || typeof counts.total !== 'number' || typeof counts.filtered !== 'number') return null;
  return {
    runKeys: q.runKeys,
    columns: q.columns,
    view: {
      filters: { search: filters.search, statuses: filters.statuses, columns: filters.columns },
      sort: (view.sort as { col: string; dir: 'asc' | 'desc' }[]).map((k) => ({ col: k.col, dir: k.dir })),
      groupBy: view.groupBy as string | null,
      maxRows: view.maxRows as number | null,
    },
    counts: { total: counts.total, filtered: counts.filtered },
  };
}

/** Upper bound for a saved UI state (it only holds settings, keys and names). */
export const MAX_UI_STATE_BYTES = 512 * 1024;

const MAX_BASE64 = Math.ceil(MAX_PNG_BYTES / 3) * 4;
const MAX_CSV_CHARS = 32 * 1024 * 1024;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Validates a message coming from the webview. Anything unexpected is rejected. */
export function parseWebviewMessage(msg: unknown): WebviewToHost | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;
  switch (m.type) {
    case 'ready':
    case 'refreshNow':
    case 'openSettings':
    case 'copyExportPath':
    case 'openExport':
    case 'copyPlotPath':
    case 'openPlot':
    case 'copyDashboardPath':
    case 'openDashboard':
      return { type: m.type };
    case 'exportDashboard':
      if (
        isStringArray(m.runKeys) &&
        m.runKeys.length <= MAX_EXPORT_RUNS &&
        isStringArray(m.chartKeys) &&
        m.chartKeys.length <= 1000 &&
        typeof m.state === 'object' &&
        m.state !== null &&
        !Array.isArray(m.state) &&
        JSON.stringify(m.state).length <= MAX_UI_STATE_BYTES
      ) {
        return { type: 'exportDashboard', runKeys: m.runKeys, chartKeys: m.chartKeys, state: m.state as Record<string, unknown> };
      }
      return null;
    case 'hideRuns':
    case 'unhideRuns':
      return isStringArray(m.runKeys) && m.runKeys.length <= 100_000 ? { type: m.type, runKeys: m.runKeys } : null;
    case 'savePlotData':
      if (typeof m.title === 'string' && m.title.length <= 200 && typeof m.csv === 'string' && m.csv.length <= MAX_CSV_CHARS) return { type: 'savePlotData', title: m.title, csv: m.csv };
      return null;
    case 'saveLineData':
      if (typeof m.metric === 'string' && m.metric.length <= 500 && isStringArray(m.runKeys) && m.runKeys.length <= 1000) {
        if (m.groups === undefined) return { type: 'saveLineData', metric: m.metric, runKeys: m.runKeys };
        return isStringRecord(m.groups) && Object.keys(m.groups).length <= 1000 ? { type: 'saveLineData', metric: m.metric, runKeys: m.runKeys, groups: m.groups } : null;
      }
      return null;
    case 'savePlot':
      if (typeof m.title === 'string' && m.title.length <= 200 && typeof m.data === 'string' && m.data.length <= MAX_BASE64 && BASE64.test(m.data)) {
        return { type: 'savePlot', title: m.title, data: m.data };
      }
      return null;
    case 'exportTable': {
      const request = parseExportRequest(m.request);
      return request ? { type: 'exportTable', request } : null;
    }
    case 'requestSeries':
      if (isStringArray(m.runKeys) && isStringArray(m.metrics) && m.runKeys.length <= 1000 && m.metrics.length <= 1000) {
        return { type: 'requestSeries', runKeys: m.runKeys, metrics: m.metrics };
      }
      return null;
    case 'saveState':
      if (typeof m.state === 'object' && m.state !== null && !Array.isArray(m.state) && JSON.stringify(m.state).length <= MAX_UI_STATE_BYTES) {
        return { type: 'saveState', state: m.state as Record<string, unknown> };
      }
      return null;
    case 'requestDetail':
    case 'copyRunPath':
      return typeof m.runKey === 'string' ? { type: m.type, runKey: m.runKey } : null;
    case 'openFile':
      if (typeof m.runKey === 'string' && (RUN_FILES as readonly unknown[]).includes(m.file)) {
        return { type: 'openFile', runKey: m.runKey, file: m.file as RunFileName };
      }
      return null;
    default:
      return null;
  }
}
