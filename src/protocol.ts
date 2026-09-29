// Typed message protocol between the extension host and the webview.
import { RUN_FILES, type RunDetail, type RunFileName, type RunSummary, type SeriesPayload, type ViewConfig } from './types';

export type HostToWebview =
  /** `scanned` is false when no scan has completed yet (runs may be empty only because discovery is pending). */
  | { type: 'runsSnapshot'; runs: RunSummary[]; refreshedAt: number; config: ViewConfig; roots: string[]; scanned: boolean }
  | { type: 'runsPatch'; upserts: RunSummary[]; removed: string[]; refreshedAt: number; roots?: string[] }
  | { type: 'series'; series: SeriesPayload[] }
  | { type: 'runDetail'; detail: RunDetail }
  | { type: 'error'; message: string };

export type WebviewToHost =
  | { type: 'ready' }
  /** Declares the full set of series the webview currently plots (replaces the previous request). */
  | { type: 'requestSeries'; runKeys: string[]; metrics: string[] }
  | { type: 'requestDetail'; runKey: string }
  | { type: 'openFile'; runKey: string; file: RunFileName }
  | { type: 'refreshNow' }
  /** Opens the VS Code settings UI filtered to TraceML settings. */
  | { type: 'openSettings' };

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

/** Validates a message coming from the webview. Anything unexpected is rejected. */
export function parseWebviewMessage(msg: unknown): WebviewToHost | null {
  if (typeof msg !== 'object' || msg === null) return null;
  const m = msg as Record<string, unknown>;
  switch (m.type) {
    case 'ready':
    case 'refreshNow':
    case 'openSettings':
      return { type: m.type };
    case 'requestSeries':
      if (isStringArray(m.runKeys) && isStringArray(m.metrics) && m.runKeys.length <= 1000 && m.metrics.length <= 1000) {
        return { type: 'requestSeries', runKeys: m.runKeys, metrics: m.metrics };
      }
      return null;
    case 'requestDetail':
      return typeof m.runKey === 'string' ? { type: 'requestDetail', runKey: m.runKey } : null;
    case 'openFile':
      if (typeof m.runKey === 'string' && (RUN_FILES as readonly unknown[]).includes(m.file)) {
        return { type: 'openFile', runKey: m.runKey, file: m.file as RunFileName };
      }
      return null;
    default:
      return null;
  }
}
