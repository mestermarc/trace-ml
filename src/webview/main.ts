// Webview entry point. The webview is a pure view: all filesystem access happens in the extension host.
import 'uplot/dist/uPlot.min.css';
import './styles.css';
import type { HostToWebview } from '../protocol';
import { Analysis } from './analysis';
import { ComparisonView } from './comparison';
import { renderInspector } from './detail';
import { h } from './dom';
import { Toolbar } from './filters';
import { OverviewView } from './overview';
import { Plots } from './plots';
import { Shell } from './shell';
import { AppState, type Area } from './state';
import { RunTable } from './table';

const st = new AppState();
const shell = new Shell(st);
const toolbar = new Toolbar(st);
const table = new RunTable(st);
const plots = new Plots(st);
const analysis = new Analysis(st, plots, (key) => {
  st.focus(key);
  table.reveal(key);
});
const overview = new OverviewView(st);
const comparison = new ComparisonView(st);

shell.addView('overview', overview.el);
shell.addView('runs', h('div', { class: 'runs-view page' }, toolbar.el, table.el, analysis.el));
shell.addView('compare', comparison.el);

// -- inspector ------------------------------------------------------------------------

let inspectorKey = '';
function renderInspectorPanel(): void {
  const run = st.s.focused ? st.runs.get(st.s.focused) : undefined;
  shell.inspector.hidden = !run;
  shell.el.classList.toggle('inspector-open', !!run);
  if (!run) {
    inspectorKey = '';
    shell.inspector.replaceChildren();
    return;
  }
  // Re-render only when something shown actually changed (avoids flicker on live refresh).
  const key = JSON.stringify([run, st.detail, st.s.selected.includes(run.key), st.s.colors[run.key]]);
  if (key === inspectorKey) return;
  inspectorKey = key;
  const scroll = shell.inspector.scrollTop;
  shell.inspector.replaceChildren(renderInspector(st, run, st.detail, () => st.focus(null)));
  shell.inspector.scrollTop = scroll;
}

shell.inspector.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') st.focus(null);
});

st.subscribe((areas: Set<Area>) => {
  shell.render(areas);
  if (st.s.view === 'runs') {
    toolbar.render(areas);
    table.render(areas);
    analysis.render(areas);
  }
  if (st.s.view === 'overview' && (areas.has('runs') || areas.has('nav') || areas.has('detail') || areas.has('status'))) overview.render();
  if (st.s.view === 'compare') comparison.render();
  if (areas.has('detail') || areas.has('selection') || areas.has('runs') || areas.has('nav')) renderInspectorPanel();
});

document.getElementById('app')!.append(shell.el);

window.addEventListener('message', (e: MessageEvent<HostToWebview>) => st.handle(e.data));
st.post({ type: 'ready' });
st.requestDetail();
st.requestSeries();
st.changed('runs', 'table', 'plots', 'detail', 'toolbar', 'status', 'nav');
