// Run inspector: a side panel with the most useful information first (status, overview, key
// metrics), then error, parameters, metrics, run info, configuration and file actions.
import type { RunDetail, RunFileName, RunSummary } from '../types';
import { formatDuration, formatNumber, formatScalar, formatTimeFull, h, palette, relativeAge } from './dom';
import type { AppState } from './state';
import { button, icon, statusEl } from './ui';

const TRACEBACK_TAIL_LINES = 40;
const FILE_BUTTONS: RunFileName[] = ['params.yaml', 'config.json', 'metrics.jsonl', 'logs/run.log', 'run.json', 'metrics.json'];

/** Open/closed state of inspector sections, kept across re-renders and runs. */
const sectionOpen = new Map<string, boolean>([
  ['Run info', false],
  ['Last values', false],
]);

function section(title: string, body: Node | null, opts: { count?: number; cls?: string } = {}): HTMLElement | null {
  if (!body) return null;
  const open = sectionOpen.get(title) ?? true;
  const d = h(
    'details',
    { class: `insp-section${opts.cls ? ` ${opts.cls}` : ''}`, open },
    h('summary', {}, icon('chevronRight', 13), h('span', { class: 'insp-section-title' }, title), opts.count !== undefined ? h('span', { class: 'insp-count' }, String(opts.count)) : null),
    h('div', { class: 'insp-section-body' }, body),
  );
  d.addEventListener('toggle', () => sectionOpen.set(title, d.open));
  return d;
}

function kv(rows: [string, Node | string | null | undefined][], cls = 'kv'): HTMLElement | null {
  const shown = rows.filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (!shown.length) return null;
  return h('dl', { class: cls }, ...shown.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v as Node | string)]));
}

/** Renders any JSON value as a collapsible tree using native <details>; children are built lazily. */
export function jsonTree(value: unknown, depth = 0, key?: string): Node {
  const keyEl = key !== undefined ? h('span', { class: 'jt-key' }, key) : null;
  const sep = key !== undefined ? h('span', { class: 'jt-sep' }, ': ') : null;
  if (value === null || typeof value !== 'object') {
    const cls = value === null ? 'jt-null' : typeof value === 'string' ? 'jt-str' : typeof value === 'number' ? 'jt-num' : 'jt-bool';
    return h('div', { class: 'jt-leaf' }, keyEl, sep, h('span', { class: cls }, typeof value === 'string' ? JSON.stringify(value) : String(value)));
  }
  const isArr = Array.isArray(value);
  const entries = isArr ? (value as unknown[]).map((v, i) => [String(i), v] as const) : Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return h('div', { class: 'jt-leaf' }, keyEl, sep, h('span', { class: 'jt-null' }, isArr ? '[]' : '{}'));
  if (isArr && entries.length <= 8 && entries.every(([, v]) => v === null || typeof v !== 'object')) {
    return h('div', { class: 'jt-leaf' }, keyEl, sep, h('span', { class: 'jt-num' }, JSON.stringify(value)));
  }
  const d = h('details', { class: 'jt-node', open: depth < 1 }, h('summary', {}, keyEl ?? h('span', { class: 'jt-key' }, 'config'), h('span', { class: 'jt-meta' }, isArr ? ` [${entries.length}]` : ` {${entries.length}}`)));
  let built = false;
  const build = () => {
    if (built) return;
    built = true;
    d.append(h('div', { class: 'jt-children' }, ...entries.map(([k, v]) => jsonTree(v, depth + 1, k))));
  };
  if (depth < 1) build();
  else d.addEventListener('toggle', build);
  return d;
}

/** Up to six "key metrics" for the overview: best metrics first, then numeric summary values. */
function keyMetrics(run: RunSummary): [string, string][] {
  const out: [string, string][] = [];
  for (const [k, b] of Object.entries(run.best)) if (b.value !== null) out.push([`best ${k}`, formatNumber(b.value)]);
  for (const [k, v] of Object.entries(run.summary)) if (typeof v === 'number' && !k.endsWith('_best')) out.push([k, formatNumber(v)]);
  return out.slice(0, 6);
}

export function renderInspector(st: AppState, run: RunSummary, detail: RunDetail | null, onClose: () => void): HTMLElement {
  const m = detail?.meta ?? null;
  const selected = st.s.selected.includes(run.key);
  const color = palette()[st.colorIndex(run.key)];
  const unknownHb = run.status === 'running' && !run.heartbeatKnown;

  // -- header -------------------------------------------------------------------
  const selectBtn = button({
    label: selected ? 'Selected' : 'Select',
    icon: selected ? 'check' : 'plus',
    variant: selected ? 'primary' : 'secondary',
    title: selected ? 'Remove from selection (plots / comparison)' : 'Add to selection (plots / comparison)',
    onClick: () => st.toggleSelected(run.key),
  });
  const head = h(
    'header',
    { class: 'insp-head' },
    h(
      'div',
      { class: 'insp-title-row' },
      selected ? h('span', { class: 'swatch lg', style: `background:${color}`, title: 'Plot colour' }) : null,
      h('h2', { class: 'insp-title', title: run.name }, run.name),
      statusEl(run.displayStatus, unknownHb ? '?' : '', unknownHb ? 'running — no heartbeat_at' : run.displayStatus),
      h('div', { class: 'spacer' }),
      button({ icon: 'close', title: 'Close details (Esc)', variant: 'ghost', onClick: onClose }),
    ),
    h(
      'div',
      { class: 'insp-sub' },
      [run.group, run.startedAt !== null ? formatTimeFull(run.startedAt) : null, run.tags.length ? run.tags.map((t) => `#${t}`).join(' ') : null].filter(Boolean).join('  ·  ') || 'no metadata',
    ),
    h('div', { class: 'insp-id mono', title: run.location }, run.id),
    h('div', { class: 'insp-actions' }, selectBtn),
  );

  // -- problems -----------------------------------------------------------------
  const warnings = run.warnings.length
    ? h(
        'div',
        { class: 'callout warning', role: 'note' },
        icon('warning', 15),
        h('div', {}, h('div', { class: 'callout-title' }, 'File problems'), h('ul', {}, ...run.warnings.map((w) => h('li', {}, w)))),
      )
    : null;

  const exit = m?.exit;
  let errorBlock: HTMLElement | null = null;
  if (exit && (exit.errorType || exit.errorMessage || exit.traceback || run.status === 'failed')) {
    const tbLines = (exit.traceback ?? '').split('\n');
    const tail = tbLines.slice(-TRACEBACK_TAIL_LINES).join('\n');
    errorBlock = h(
      'div',
      { class: 'callout error', role: 'note' },
      icon('warning', 15),
      h(
        'div',
        { class: 'callout-main' },
        h('div', { class: 'callout-title' }, `Run failed${exit.errorType ? `: ${exit.errorType}` : ''}`),
        exit.errorMessage ? h('div', { class: 'callout-text' }, exit.errorMessage) : null,
        h('div', { class: 'muted small' }, [exit.code !== null ? `exit code ${exit.code}` : null, exit.signal ? `signal ${exit.signal}` : null].filter(Boolean).join(' · ')),
        exit.traceback ? h('pre', { class: 'traceback' }, (tbLines.length > TRACEBACK_TAIL_LINES ? '…\n' : '') + tail) : null,
      ),
    );
  }

  // -- overview -----------------------------------------------------------------
  const stat = (label: string, value: string, title = '') => h('div', { class: 'stat', title }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, value || '—'));
  const overview = h(
    'div',
    { class: 'stat-grid' },
    stat('Duration', formatDuration(run.durationS)),
    stat('Step', run.step !== null ? String(run.step) : ''),
    stat('Epoch', run.epoch !== null ? String(run.epoch) : ''),
    stat('Heartbeat', run.heartbeatAt !== null ? relativeAge(run.heartbeatAt) : unknownHb ? 'unknown' : '', run.heartbeatAt !== null ? formatTimeFull(run.heartbeatAt) : ''),
    ...keyMetrics(run).map(([k, v]) => stat(k, v, k)),
  );

  // -- parameters ---------------------------------------------------------------
  const paramEntries = Object.entries(run.params);
  const params = paramEntries.length ? kv(paramEntries.map(([k, v]) => [k, h('span', { class: 'mono' }, formatScalar(v) || 'null')]), 'kv params') : null;

  // -- metrics ------------------------------------------------------------------
  const bestRows = Object.entries(run.best).map(([k, b]) =>
    h(
      'tr',
      {},
      h('th', {}, k),
      h('td', { class: 'num' }, b.value === null ? '—' : formatNumber(b.value)),
      h('td', { class: 'muted' }, [b.mode, b.step !== null ? `@ step ${b.step}` : null].filter(Boolean).join(' ')),
    ),
  );
  const summaryRows = Object.entries(run.summary).map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', { class: 'num' }, formatScalar(v) || '—'), h('td', {})));
  const lastRows = Object.entries(run.last).map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', { class: 'num' }, formatScalar(v) || '—'), h('td', {})));
  const table = (rows: HTMLElement[]) => (rows.length ? h('table', { class: 'metric-table' }, h('tbody', {}, ...rows)) : null);

  // -- run info -----------------------------------------------------------------
  const host = m?.host;
  const git = m?.git;
  const info = kv([
    ['started', run.startedAt !== null ? formatTimeFull(run.startedAt) : null],
    ['ended', run.endedAt !== null ? formatTimeFull(run.endedAt) : null],
    ['status file', run.displayStatus !== run.status ? `${run.status} (shown as ${run.displayStatus})` : null],
    ['command', m?.command ? h('code', { class: 'wrap' }, m.command.join(' ')) : null],
    ['cwd', m?.cwd ? h('code', {}, m.cwd) : null],
    ['host', host?.hostname ? `${host.hostname}${host.pid !== undefined ? ` (pid ${host.pid})` : ''}` : null],
    ['user', host?.user],
    ['runtime', [host?.python ? `python ${host.python}` : null, host?.torch ? `torch ${host.torch}` : null, host?.cuda ? `cuda ${host.cuda}` : null].filter(Boolean).join(' · ') || null],
    ['gpus', Array.isArray(host?.gpus) ? host!.gpus!.join(', ') : null],
    ['git', git ? [git.branch, git.sha ? String(git.sha).slice(0, 10) : null, git.dirty ? 'dirty' : null].filter(Boolean).join(' · ') : null],
    ['remote', git?.remote],
    ['location', h('code', {}, run.location)],
    ['notes', run.notes],
  ]);

  // -- config -------------------------------------------------------------------
  let config: Node;
  if (!detail) config = h('div', { class: 'skeleton-lines', 'aria-label': 'Loading' }, h('span', {}), h('span', {}), h('span', {}));
  else if (detail.configError) config = h('div', { class: 'callout warning compact' }, icon('warning', 14), h('span', {}, detail.configError));
  else if (detail.config === null || detail.config === undefined) config = h('div', { class: 'muted' }, 'No config.json in this run.');
  else config = h('div', { class: 'json-tree' }, jsonTree(detail.config));

  // -- files --------------------------------------------------------------------
  const files = h(
    'div',
    { class: 'file-list' },
    ...FILE_BUTTONS.map((f) => {
      const exists = detail ? (detail.files.find((x) => x.name === f)?.exists ?? false) : true;
      const b = h('button', { type: 'button', class: 'file-btn', disabled: !exists, title: exists ? `Open ${f} in the editor` : `${f} not found` }, icon('file', 14), h('span', {}, f));
      b.addEventListener('click', () => st.post({ type: 'openFile', runKey: run.key, file: f }));
      return b;
    }),
  );

  const noMetrics = !bestRows.length && !summaryRows.length && !lastRows.length;
  return h(
    'div',
    { class: 'insp' },
    head,
    h(
      'div',
      { class: 'insp-body' },
      errorBlock,
      warnings,
      section('Overview', overview),
      noMetrics
        ? section('Metrics', h('div', { class: 'muted' }, 'No metrics.json summary in this run.'))
        : section('Metrics', h('div', {}, bestRows.length ? h('h3', {}, 'Best') : null, table(bestRows), summaryRows.length ? h('h3', {}, 'Summary') : null, table(summaryRows))),
      lastRows.length ? section('Last values', table(lastRows), { count: lastRows.length }) : null,
      section('Parameters', params ?? h('div', { class: 'muted' }, 'No params.yaml in this run.'), { count: paramEntries.length }),
      section('Configuration', config),
      section('Run info', info),
      section('Files', files),
    ),
  );
}
