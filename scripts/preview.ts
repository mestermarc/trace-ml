// Dev-only: renders the real webview bundle in a normal browser, without VS Code.
// Runs the real host-side discovery/parsing over a runs directory, embeds the results in a static
// HTML page and mocks `acquireVsCodeApi`. Not part of the extension package.
//
//   npm run build && npm run preview -- test-data   ->  writes test-data/preview.html
import { writeFileSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { listRuns, resolveRunsRoots } from '../src/discovery';
import { RunStore } from '../src/runStore';
import type { RunDetail, SeriesPayload } from '../src/types';

async function main(): Promise<void> {
  const ws = resolve(process.argv[2] ?? 'test-data');
  const out = resolve(ws, 'preview.html');
  const maxSeriesRuns = Number(process.argv[3] ?? 40);
  const store = new RunStore({ staleAfterSeconds: 60, maxPointsPerSeries: 5000, finishedCheckEvery: 6, maxIdleHistories: 1000 });
  const { roots } = await resolveRunsRoots([], [/[\\/]runs$/.test(ws) ? ws : resolve(ws, 'runs')]);
  const discovered = (await Promise.all(roots.map((r) => listRuns(r, new Map())))).flat();
  const { upserts } = await store.sync(discovered, { force: true });

  const series: Record<string, SeriesPayload> = {};
  const details: Record<string, RunDetail> = {};
  for (const run of upserts.slice(0, maxSeriesRuns)) {
    await store.pollHistory(run.key);
    for (const m of run.metricNames) {
      const s = store.getSeries(run.key, m);
      if (s) series[`${run.key}\u0000${m}`] = s;
    }
  }
  for (const run of upserts) {
    const d = await store.loadDetail(run.key);
    if (d) details[run.key] = d;
  }
  const runs = store.summaries();
  const data = { runs, roots: roots.map((r) => r.label), series, details };
  const dist = relative(dirname(out), resolve('dist')).replace(/\\/g, '/');

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>TraceML preview</title>
<link rel="stylesheet" href="${dist}/webview.css">
<style>
  /* Approximation of VS Code Dark+ theme variables */
  body { --vscode-font-family: -apple-system, 'Segoe UI', sans-serif; --vscode-font-size: 13px; --vscode-foreground: #cccccc;
    --vscode-editor-background: #1e1e1e; --vscode-descriptionForeground: #9d9d9d; --vscode-panel-border: #3c3c3c;
    --vscode-list-hoverBackground: #2a2d2e; --vscode-list-inactiveSelectionBackground: #37373d; --vscode-list-activeSelectionBackground: #04395e;
    --vscode-list-activeSelectionForeground: #ffffff; --vscode-button-background: #0e639c; --vscode-button-foreground: #fff;
    --vscode-button-hoverBackground: #1177bb; --vscode-button-secondaryBackground: #3a3d41; --vscode-button-secondaryForeground: #fff;
    --vscode-button-secondaryHoverBackground: #45494e; --vscode-input-background: #3c3c3c; --vscode-input-foreground: #ccc;
    --vscode-focusBorder: #007fd4; --vscode-editorWidget-background: #252526; --vscode-charts-blue: #3794ff; --vscode-charts-red: #f14c4c;
    --vscode-charts-green: #89d185; --vscode-charts-yellow: #cca700; --vscode-charts-orange: #d18616; --vscode-charts-purple: #b180d7;
    --vscode-editorGroupHeader-tabsBackground: #252526; --vscode-errorForeground: #f48771; --vscode-editorWarning-foreground: #cca700; }
  body.vscode-light { --vscode-foreground: #3b3b3b; --vscode-editor-background: #ffffff; --vscode-descriptionForeground: #717171;
    --vscode-panel-border: #e5e5e5; --vscode-list-hoverBackground: #f0f0f0; --vscode-list-inactiveSelectionBackground: #e4e6f1;
    --vscode-list-activeSelectionBackground: #0060c0; --vscode-input-background: #fff; --vscode-input-foreground: #3b3b3b;
    --vscode-input-border: #cecece; --vscode-editorGroupHeader-tabsBackground: #f3f3f3; --vscode-button-secondaryBackground: #e5e5e5;
    --vscode-button-secondaryForeground: #3b3b3b; --vscode-button-secondaryHoverBackground: #cccccc; --vscode-editorWidget-background: #f3f3f3;
    --vscode-charts-blue: #1a85ff; --vscode-charts-green: #388a34; --vscode-charts-yellow: #bf8803; }
</style>
</head><body class="vscode-dark"><div id="app"></div>
<script>
const DATA = ${JSON.stringify(data).replace(/</g, '\\u003c')};
let state; try { state = JSON.parse(localStorage.getItem('traceml-preview') || 'null'); } catch {}
if (location.hash.startsWith('#demo')) {
  // #demo: pre-select a few runs and focus one, for screenshots
  const pick = ['baseline', 'high-lr', 'small-model', 'failed-run'].map((n) => DATA.runs.find((r) => r.name === n)).filter(Boolean).map((r) => r.key);
  const focus = (/^#demo:([^&]*)/.exec(location.hash) || [])[1];
  state = { version: 1, sort: [{ col: 'started', dir: 'desc' }], filters: { search: '', statuses: [], columns: {} }, selected: pick,
    visibleColumns: null, differingOnly: false, focused: (DATA.runs.find((r) => r.name === (focus || 'failed-run')) || {}).key || null,
    bottomTab: location.hash.includes('compare') ? 'compare' : 'detail',
    plot: { metrics: null, xMode: 'step', logY: false, smoothing: location.hash.includes('smooth') ? 0.6 : 0, hidden: [], colorBy: 'run' }, colors: {}, tableHeight: 320 };
  // e.g. #demo&view=scatter&group=param:data.dataset&logx
  const q = new URLSearchParams(location.hash.slice(1).replace(/^demo[^&]*/, ''));
  state.groupBy = q.get('group');
  state.analysis = { view: q.get('view') || 'line', x: q.get('x'), y: q.get('y'), size: q.get('size'), color: 'auto', boxField: q.get('y'), boxGroup: 'auto', logX: q.has('logx'), logY: false };
  document.body.className = location.hash.includes('light') ? 'vscode-light' : 'vscode-dark';
}
window.acquireVsCodeApi = () => ({
  getState: () => state,
  setState: (s) => { state = s; try { localStorage.setItem('traceml-preview', JSON.stringify(s)); } catch {} },
  postMessage: (msg) => setTimeout(() => {
    const send = (m) => window.postMessage(m, '*');
    console.log('[TraceML mock] <-', msg.type);
    switch (msg.type) {
      case 'ready':
        send({ type: 'runsSnapshot', runs: [], refreshedAt: 0, scanned: false, config: { staleAfterSeconds: 60, refreshIntervalSeconds: 5, maxPointsPerSeries: 5000 }, roots: DATA.roots });
        setTimeout(() => send({ type: 'runsPatch', upserts: DATA.runs, removed: [], refreshedAt: Date.now(), roots: DATA.roots }), 150);
        break;
      case 'refreshNow': send({ type: 'runsPatch', upserts: [], removed: [], refreshedAt: Date.now() }); break;
      case 'requestSeries': {
        const out = [];
        for (const k of msg.runKeys) for (const m of msg.metrics) { const s = DATA.series[k + '\\u0000' + m]; if (s) out.push(s); }
        send({ type: 'series', series: out }); break;
      }
      case 'requestDetail': if (DATA.details[msg.runKey]) send({ type: 'runDetail', detail: DATA.details[msg.runKey] }); break;
      case 'openFile': send({ type: 'error', message: 'openFile(' + msg.file + ') — only available inside VS Code' }); break;
    }
  }, 20),
});
</script>
<script src="${dist}/webview.js"></script>
</body></html>`;
  writeFileSync(out, html);
  console.log(`wrote ${out} (${runs.length} runs, ${Object.keys(series).length} series)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
