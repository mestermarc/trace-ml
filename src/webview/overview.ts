// Overview: status counts, active (running / stale) runs, most recent runs and run roots.
// Everything is derived from the already-loaded run summaries.
import { DISPLAY_STATUSES, type DisplayStatus, type RunSummary } from '../types';
import { formatDuration, formatNumber, formatTime, h, relativeAge } from './dom';
import { rootFilterExpr } from './shell';
import type { AppState } from './state';
import { emptyState, icon, statusEl } from './ui';

const RECENT = 10;

export class OverviewView {
  readonly el = h('div', { class: 'overview' });
  private key = '';

  constructor(private readonly st: AppState) {}

  render(): void {
    if (this.st.s.view !== 'overview') return;
    const runs = this.st.allRuns();
    const key = JSON.stringify([runs.map((r) => [r.key, r.displayStatus, r.step, r.heartbeatAt, r.durationS]), this.st.roots, this.st.loaded, this.st.s.focused]);
    if (key === this.key) return;
    this.key = key;
    this.el.replaceChildren(this.build(runs));
  }

  private showRuns(status: DisplayStatus | null): void {
    this.st.s.filters.statuses = status ? [status] : [];
    this.st.navigate('runs');
    this.st.changed('table', 'toolbar', 'plots');
  }

  private runList(runs: RunSummary[], extra: (r: RunSummary) => (Node | string)[]): HTMLElement {
    return h(
      'ul',
      { class: 'run-list' },
      ...runs.map((r) => {
        const b = h(
          'button',
          { type: 'button', class: `run-list-item${r.key === this.st.s.focused ? ' focused' : ''}`, title: `${r.id}\nOpen details` },
          statusEl(r.displayStatus),
          h('span', { class: 'run-list-name' }, r.name),
          r.group ? h('span', { class: 'run-list-group' }, r.group) : '',
          h('span', { class: 'spacer' }),
          ...extra(r),
        );
        b.addEventListener('click', () => this.st.focus(r.key));
        return h('li', {}, b);
      }),
    );
  }

  private build(runs: RunSummary[]): HTMLElement {
    if (!runs.length)
      return h(
        'div',
        { class: 'page' },
        this.st.loaded
          ? emptyState({ icon: 'inbox', title: 'No experiments found', text: 'TraceML did not find any runs under the configured roots.', action: { label: 'Refresh', icon: 'refresh', onClick: () => this.st.refreshNow() } })
          : emptyState({ busy: true, title: 'Scanning for runs…' }),
      );

    const counts = new Map<DisplayStatus, number>();
    for (const r of runs) counts.set(r.displayStatus, (counts.get(r.displayStatus) ?? 0) + 1);
    const tile = (label: string, n: number, status: DisplayStatus | null) => {
      const b = h(
        'button',
        { type: 'button', class: `stat-tile${status ? ` st-${status}` : ''}`, title: status ? `Show ${status} runs` : 'Show all runs' },
        h('span', { class: 'stat-tile-label' }, status ? h('span', { class: 'dot', 'aria-hidden': 'true' }) : '', label),
        h('span', { class: 'stat-tile-value' }, String(n)),
      );
      b.addEventListener('click', () => this.showRuns(status));
      return b;
    };

    const active = runs
      .filter((r) => r.displayStatus === 'running' || r.displayStatus === 'stale')
      .sort((a, b) => (b.heartbeatAt ?? 0) - (a.heartbeatAt ?? 0));
    const recent = runs
      .filter((r) => r.startedAt !== null)
      .sort((a, b) => b.startedAt! - a.startedAt!)
      .slice(0, RECENT);
    const keyMetric = (r: RunSummary) => {
      const e = Object.entries(r.best).find(([, b]) => b.value !== null);
      return e ? h('span', { class: 'run-list-metric', title: `best ${e[0]}` }, h('span', { class: 'muted' }, e[0]), ` ${formatNumber(e[1].value!)}`) : '';
    };

    const rootCounts = this.st.roots.map((root) => [root, runs.filter((r) => r.location.startsWith(root + '/')).length] as const);

    return h(
      'div',
      { class: 'page' },
      h(
        'div',
        { class: 'stat-tiles' },
        tile('All runs', runs.length, null),
        ...DISPLAY_STATUSES.filter((s) => counts.get(s)).map((s) => tile(s[0]!.toUpperCase() + s.slice(1), counts.get(s)!, s)),
      ),
      h(
        'div',
        { class: 'overview-grid' },
        h(
          'section',
          { class: 'panel' },
          h('header', { class: 'panel-head' }, h('h2', {}, 'Active runs'), h('span', { class: 'muted small' }, `${active.length}`)),
          active.length
            ? this.runList(active, (r) => [
                h('span', { class: 'run-list-meta tabular' }, r.step !== null ? `step ${r.step}` : ''),
                h('span', { class: 'run-list-meta', title: r.heartbeatAt !== null ? `heartbeat ${formatTime(r.heartbeatAt)}` : 'no heartbeat' }, r.heartbeatAt !== null ? relativeAge(r.heartbeatAt) : '—'),
              ])
            : emptyState({ compact: true, icon: 'activity', title: 'No active runs', text: 'Running runs appear here and update live.' }),
        ),
        h(
          'section',
          { class: 'panel' },
          h('header', { class: 'panel-head' }, h('h2', {}, 'Recent runs'), h('span', { class: 'muted small' }, 'by start time')),
          recent.length
            ? this.runList(recent, (r) => [keyMetric(r), h('span', { class: 'run-list-meta tabular' }, formatDuration(r.durationS))])
            : emptyState({ compact: true, icon: 'runs', title: 'No start times', text: 'Runs without run.json have no start time.' }),
        ),
        h(
          'section',
          { class: 'panel' },
          h('header', { class: 'panel-head' }, h('h2', {}, 'Run roots'), h('span', { class: 'muted small' }, `${rootCounts.length}`)),
          h(
            'ul',
            { class: 'run-list' },
            ...rootCounts.map(([root, n]) => {
              const b = h('button', { type: 'button', class: 'run-list-item', title: `Show runs under ${root}` }, icon('folder', 14), h('span', { class: 'run-list-name mono' }, root), h('span', { class: 'spacer' }), h('span', { class: 'run-list-meta' }, `${n} runs`));
              b.addEventListener('click', () => {
                this.st.s.filters.columns.location = rootFilterExpr(root);
                this.st.navigate('runs');
                this.st.changed('table', 'toolbar', 'plots');
              });
              return h('li', {}, b);
            }),
          ),
        ),
      ),
    );
  }
}
