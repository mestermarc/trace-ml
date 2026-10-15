// "Export dashboard": one self-contained, read-only HTML file with the real webview bundle, its CSS
// and the run data embedded, viewable in any browser without VS Code or the runs folder. Pure (no
// vscode, no fs): the extension passes in the file contents and the data.
//
// The page talks to no host: a small inline stand-in for the VS Code API answers the webview's
// messages from the embedded data. Its Content-Security-Policy allows no network access at all,
// so a shared file can't load or send anything. Absolute run folder paths (the run keys, and the
// labels of runs folders outside the workspace) are replaced by neutral ids / folder names so the
// file doesn't reveal the exporter's directory layout.
import { basename, isAbsolutePath } from './paths';
import type { RunDetail, RunSummary, SeriesPayload, ViewConfig } from './types';

export interface DashboardData {
  runs: RunSummary[];
  /** Runs-folder labels as shown in the sidebar. */
  roots: string[];
  series: SeriesPayload[];
  details: RunDetail[];
  config: ViewConfig;
}

export interface DashboardInput extends DashboardData {
  /** dist/webview.js and dist/webview.css of this extension version. */
  js: string;
  css: string;
  /** media/curly_m.svg (embedded as a data URI). */
  logoSvg: string;
  /** The exporter's view (selection, plots, filters...), restored for the recipient. */
  state: Record<string, unknown>;
  /** ISO time of the export, shown in the page. */
  exportedAt: string;
  /** Random token for the inline scripts' CSP nonce. */
  nonce: string;
}

/**
 * Replaces each run key by `run-<n>` everywhere it appears (runs, series, details, saved view), and
 * absolute runs-folder labels (folders outside the workspace) by their folder name.
 */
export function anonymizeKeys(data: DashboardData, state: Record<string, unknown>): { data: DashboardData; state: Record<string, unknown> } {
  const rootNames = new Map<string, string>();
  for (const r of data.roots) {
    if (!isAbsolutePath(r)) continue;
    const base = basename(r) || 'runs';
    let name = base;
    for (let i = 2; [...rootNames.values()].includes(name); i++) name = `${base}-${i}`;
    rootNames.set(r, name);
  }
  const shorten = (loc: string) => {
    for (const [abs, name] of rootNames) if (loc === abs || loc.startsWith(`${abs}/`)) return name + loc.slice(abs.length);
    return isAbsolutePath(loc) ? basename(loc) : loc;
  };
  const ids = new Map<string, string>();
  data.runs.forEach((r, i) => ids.set(r.key, `run-${i + 1}`));
  const id = (k: string) => ids.get(k);
  const keys = (v: unknown) => (Array.isArray(v) ? v.flatMap((k) => (typeof k === 'string' && id(k) ? [id(k)!] : [])) : []);
  const s: Record<string, unknown> = { ...state, selected: keys(state.selected) };
  s.focused = typeof state.focused === 'string' ? (id(state.focused) ?? null) : null;
  if (state.colors && typeof state.colors === 'object') {
    s.colors = Object.fromEntries(Object.entries(state.colors as Record<string, unknown>).flatMap(([k, v]) => (id(k) ? [[id(k)!, v]] : [])));
  }
  if (state.plot && typeof state.plot === 'object') {
    const plot = state.plot as Record<string, unknown>;
    s.plot = { ...plot, hidden: keys(plot.hidden) };
  }
  // a "Run roots" filter in the sidebar is a location condition naming the root
  const filters = state.filters as { columns?: Record<string, unknown> } | undefined;
  if (filters?.columns && typeof filters.columns.location === 'string') {
    let expr = filters.columns.location;
    for (const [abs, name] of rootNames) expr = expr.split(abs).join(name);
    s.filters = { ...filters, columns: { ...filters.columns, location: expr } };
  }
  return {
    data: {
      ...data,
      roots: data.roots.map((r) => rootNames.get(r) ?? r),
      runs: data.runs.map((r) => ({ ...r, key: id(r.key)!, location: shorten(r.location) })),
      series: data.series.flatMap((p) => (id(p.runKey) ? [{ ...p, runKey: id(p.runKey)! }] : [])),
      details: data.details.flatMap((d) => (id(d.key) ? [{ ...d, key: id(d.key)! }] : [])),
    },
    state: s,
  };
}

/** JSON safe to embed in an inline <script> (no `</script>`, no HTML comment openers). */
export function inlineJson(v: unknown): string {
  return JSON.stringify(v)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/**
 * Code / CSS safe to embed inline: a closing tag inside it would end the element early, and `<!--`
 * could switch the HTML parser into a mode where the real closing tag doesn't count. Both are
 * escaped in a way that means the same in JS strings, regexes and templates (and in CSS).
 */
function inlineText(text: string, tag: 'script' | 'style'): string {
  return text.replace(new RegExp(`</${tag}`, 'gi'), `<\\/${tag}`).replace(/<!--/g, '<\\!--');
}

/** Exported dashboard file names in the cache folder (`dashboards/`). */
export const DASHBOARD_NAME = /^dashboard-\d{8}-\d{6}\.html$/;

/** File-name-safe UTC stamp: 20261013-171500. */
export function dashboardStamp(iso: string): string {
  return iso.replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

/** Approximation of the VS Code Dark+ / Light+ theme variables the webview CSS builds on. */
const THEME = `
body { --vscode-font-family: -apple-system, 'Segoe UI', sans-serif; --vscode-font-size: 13px; --vscode-foreground: #cccccc;
  --vscode-editor-background: #1e1e1e; --vscode-descriptionForeground: #9d9d9d; --vscode-panel-border: #3c3c3c;
  --vscode-list-hoverBackground: #2a2d2e; --vscode-list-inactiveSelectionBackground: #37373d; --vscode-list-activeSelectionBackground: #04395e;
  --vscode-list-activeSelectionForeground: #ffffff; --vscode-button-background: #0e639c; --vscode-button-foreground: #fff;
  --vscode-button-hoverBackground: #1177bb; --vscode-button-secondaryBackground: #3a3d41; --vscode-button-secondaryForeground: #fff;
  --vscode-button-secondaryHoverBackground: #45494e; --vscode-input-background: #3c3c3c; --vscode-input-foreground: #ccc;
  --vscode-focusBorder: #007fd4; --vscode-editorWidget-background: #252526; --vscode-charts-blue: #3794ff; --vscode-charts-red: #f14c4c;
  --vscode-charts-green: #89d185; --vscode-charts-yellow: #cca700; --vscode-charts-orange: #d18616; --vscode-charts-purple: #b180d7;
  --vscode-editorGroupHeader-tabsBackground: #252526; --vscode-errorForeground: #f48771; --vscode-editorWarning-foreground: #cca700;
  margin: 0; background: var(--vscode-editor-background); }
body.vscode-light { --vscode-foreground: #3b3b3b; --vscode-editor-background: #ffffff; --vscode-descriptionForeground: #717171;
  --vscode-panel-border: #e5e5e5; --vscode-list-hoverBackground: #f0f0f0; --vscode-list-inactiveSelectionBackground: #e4e6f1;
  --vscode-list-activeSelectionBackground: #0060c0; --vscode-input-background: #fff; --vscode-input-foreground: #3b3b3b;
  --vscode-input-border: #cecece; --vscode-editorGroupHeader-tabsBackground: #f3f3f3; --vscode-button-secondaryBackground: #e5e5e5;
  --vscode-button-secondaryForeground: #3b3b3b; --vscode-button-secondaryHoverBackground: #cccccc; --vscode-editorWidget-background: #f3f3f3;
  --vscode-charts-blue: #1a85ff; --vscode-charts-green: #388a34; --vscode-charts-yellow: #bf8803; }
`;

/**
 * Stand-in for acquireVsCodeApi(): answers the webview from DATA. Chart PNG / CSV saves become
 * browser downloads; actions that need VS Code or the run folders report that they aren't available.
 */
const HOST_STUB = `
(function () {
  var DATA = JSON.parse(document.getElementById('traceml-data').textContent);
  var saved = JSON.parse(document.getElementById('traceml-state').textContent);
  var storeKey = 'traceml-dashboard-' + DATA.exportedAt;
  var state = saved;
  try { var mine = JSON.parse(localStorage.getItem(storeKey) || 'null'); if (mine) state = mine; } catch (e) {}
  var series = {};
  DATA.series.forEach(function (s) { series[s.runKey + '\\u0000' + s.metric] = s; });
  var details = {};
  DATA.details.forEach(function (d) { details[d.key] = d; });
  var hidden = new Map();
  if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) document.body.className = 'vscode-light';
  function send(m) { window.postMessage(m, '*'); }
  function download(name, blob) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function fileName(title, ext) { return 'traceml-' + String(title).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) + '.' + ext; }
  function unavailable(what) { send({ type: 'error', message: what + ' is not available in an exported dashboard (open the runs in VS Code for that).' }); }
  window.acquireVsCodeApi = function () {
    return {
      getState: function () { return state; },
      setState: function (s) { state = s; try { localStorage.setItem(storeKey, JSON.stringify(s)); } catch (e) {} },
      postMessage: function (msg) {
        setTimeout(function () {
          switch (msg.type) {
            case 'ready':
              send({ type: 'runsSnapshot', runs: DATA.runs.filter(function (r) { return !hidden.has(r.key); }), refreshedAt: Date.parse(DATA.exportedAt), scanned: true, config: DATA.config, roots: DATA.roots });
              break;
            case 'requestSeries': {
              var out = [];
              msg.runKeys.forEach(function (k) { msg.metrics.forEach(function (m) { var s = series[k + '\\u0000' + m]; if (s) out.push(s); }); });
              send({ type: 'series', series: out });
              break;
            }
            case 'requestDetail': {
              var run = DATA.runs.find(function (r) { return r.key === msg.runKey; });
              if (!run) break;
              send({ type: 'runDetail', detail: details[msg.runKey] || { key: msg.runKey, meta: null, config: null, configError: 'Not included: details and metric histories are exported for the runs selected at export time.', files: [] } });
              break;
            }
            case 'savePlot': {
              var bin = atob(msg.data), bytes = new Uint8Array(bin.length);
              for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
              download(fileName(msg.title, 'png'), new Blob([bytes], { type: 'image/png' }));
              break;
            }
            case 'savePlotData':
              download(fileName(msg.title, 'csv'), new Blob([msg.csv], { type: 'text/csv' }));
              break;
            case 'hideRuns':
              msg.runKeys.forEach(function (k) { var r = DATA.runs.find(function (x) { return x.key === k; }); if (r) hidden.set(k, { key: k, id: r.id, name: r.name, location: r.location, hiddenAt: new Date().toISOString() }); });
              send({ type: 'hiddenRuns', runs: Array.from(hidden.values()) });
              send({ type: 'runsPatch', upserts: [], removed: msg.runKeys, refreshedAt: Date.parse(DATA.exportedAt) });
              break;
            case 'unhideRuns':
              msg.runKeys.forEach(function (k) { hidden.delete(k); });
              send({ type: 'hiddenRuns', runs: Array.from(hidden.values()) });
              send({ type: 'runsPatch', upserts: DATA.runs.filter(function (r) { return msg.runKeys.indexOf(r.key) >= 0; }), removed: [], refreshedAt: Date.parse(DATA.exportedAt) });
              break;
            case 'refreshNow':
              send({ type: 'runsPatch', upserts: [], removed: [], refreshedAt: Date.parse(DATA.exportedAt) });
              break;
            case 'saveLineData': unavailable('Saving the full metric history'); break;
            case 'exportTable': unavailable('Table CSV export'); break;
            case 'exportDashboard': unavailable('Exporting a dashboard'); break;
            case 'openFile': unavailable('Opening run files'); break;
            case 'copyRunPath': unavailable('Copying the run folder path'); break;
            case 'openSettings': unavailable('Settings'); break;
          }
        }, 0);
      },
    };
  };
})();
`;

/** The complete HTML page. */
export function buildDashboardHtml(input: DashboardInput): string {
  const { js, css, logoSvg, state, exportedAt, nonce, ...data } = input;
  const csp = ["default-src 'none'", "img-src data: blob:", "style-src 'unsafe-inline'", `script-src 'nonce-${nonce}'`, "connect-src 'none'", "form-action 'none'", "base-uri 'none'"].join('; ');
  const logo = `data:image/svg+xml;base64,${Buffer.from(logoSvg, 'utf-8').toString('base64')}`;
  const title = `TraceML dashboard · ${exportedAt.slice(0, 16).replace('T', ' ')} UTC`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="traceml-logo" content="${logo}">
<meta name="traceml-snapshot" content="${exportedAt.replace(/[^0-9TZ:.-]/g, '')}">
<title>${title}</title>
<style>${THEME}</style>
<style>${inlineText(css, 'style')}</style>
</head>
<body class="vscode-dark">
<div id="app"></div>
<script type="application/json" id="traceml-data">${inlineJson({ ...data, exportedAt })}</script>
<script type="application/json" id="traceml-state">${inlineJson(state)}</script>
<script nonce="${nonce}">${inlineText(HOST_STUB, 'script')}</script>
<script nonce="${nonce}">${inlineText(js, 'script')}</script>
</body>
</html>
`;
}
