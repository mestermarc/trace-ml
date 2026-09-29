// Compare view: selected runs side by side. Presents values only; differences are emphasised but
// runs are never ranked and no winner is inferred. Colours match the charts.
import { buildComparison, type ComparisonRow } from '../model/run';
import type { RunSummary } from '../types';
import { formatScalar, h, palette } from './dom';
import { MAX_PLOT_RUNS, type AppState } from './state';
import { button, chip, emptyState, statusEl, toggle } from './ui';

export class ComparisonView {
  readonly el = h('div', { class: 'compare-view' });
  private key = '';

  constructor(private readonly st: AppState) {}

  render(): void {
    if (this.st.s.view !== 'compare') return;
    const runs = this.st.selectedRuns();
    const key = JSON.stringify([runs, this.st.s.compareDiffOnly, this.st.s.focused]);
    if (key === this.key) return;
    this.key = key;
    const scrollTop = this.el.parentElement?.scrollTop ?? 0;
    this.el.replaceChildren(this.build(runs));
    if (this.el.parentElement) this.el.parentElement.scrollTop = scrollTop;
  }

  private build(runs: RunSummary[]): HTMLElement {
    if (runs.length < 2)
      return h(
        'div',
        { class: 'page' },
        emptyState({
          icon: 'compare',
          title: runs.length ? 'Select one more run' : 'Select experiments to compare',
          text: 'Tick two or more runs in the Runs table. Their parameters and metrics are shown side by side here, using the same colours as the charts.',
          action: { label: 'Go to runs', icon: 'runs', onClick: () => this.st.navigate('runs') },
        }),
      );
    const shown = runs.slice(0, MAX_PLOT_RUNS);
    const { params, metrics } = buildComparison(shown);
    const colors = palette();
    const diffOnly = this.st.s.compareDiffOnly;
    const nDiffParams = params.filter((r) => r.differs).length;
    const nDiffMetrics = metrics.filter((r) => r.differs).length;

    const strip = h(
      'div',
      { class: 'compare-strip' },
      ...shown.map((r) => {
        const c = chip(
          h('span', {}, r.name),
          () => this.st.toggleSelected(r.key, false),
          { color: colors[this.st.colorIndex(r.key)], title: `${r.id}\nClick to open details` },
        );
        c.classList.add('run-chip');
        if (r.key === this.st.s.focused) c.classList.add('focused');
        c.addEventListener('click', () => this.st.focus(r.key));
        return c;
      }),
    );

    const headRow = () =>
      h(
        'tr',
        {},
        h('th', { class: 'cmp-key', scope: 'col' }, ''),
        ...shown.map((r) => {
          const th = h(
            'th',
            { scope: 'col', title: r.id, class: r.key === this.st.s.focused ? 'focused' : '' },
            h('div', { class: 'cmp-run' }, h('span', { class: 'swatch', style: `background:${colors[this.st.colorIndex(r.key)]}` }), h('span', { class: 'cmp-run-name' }, r.name)),
            h('div', { class: 'cmp-run-status' }, statusEl(r.displayStatus)),
          );
          th.addEventListener('click', () => this.st.focus(r.key));
          return th;
        }),
      );

    const table = (rows: ComparisonRow[], sections?: (row: ComparisonRow) => string) => {
      const visible = diffOnly ? rows.filter((r) => r.differs) : rows;
      if (!visible.length) return h('div', { class: 'muted pad' }, diffOnly ? 'All values are identical.' : 'Nothing to compare.');
      const body: HTMLElement[] = [];
      let lastSection = '';
      for (const row of visible) {
        const sec = sections?.(row) ?? '';
        if (sec && sec !== lastSection) {
          lastSection = sec;
          body.push(h('tr', { class: 'cmp-section' }, h('th', { colspan: shown.length + 1, scope: 'rowgroup' }, sec)));
        }
        const label = sections ? row.label.slice(row.label.indexOf(' ') + 1) : row.label;
        body.push(
          h(
            'tr',
            { class: row.differs ? 'differs' : '' },
            h('th', { class: 'cmp-key', scope: 'row', title: row.label }, row.differs ? h('span', { class: 'diff-mark', 'aria-label': 'differs' }, '≠') : null, label),
            ...row.values.map((v) => h('td', { class: typeof v === 'number' ? 'num' : '' }, v === null ? h('span', { class: 'muted' }, '—') : formatScalar(v))),
          ),
        );
      }
      return h('div', { class: 'cmp-scroll' }, h('table', { class: 'cmp' }, h('thead', {}, headRow()), h('tbody', {}, ...body)));
    };

    const sectionName = (row: ComparisonRow) => ({ best: 'Best', summary: 'Summary', last: 'Last' })[row.label.split(' ')[0] as 'best'] ?? '';

    return h(
      'div',
      { class: 'page' },
      h(
        'div',
        { class: 'page-head' },
        h('div', {}, h('h2', { class: 'page-title' }, `Compare ${shown.length} runs`), h('div', { class: 'muted small' }, 'Values only — TraceML does not rank runs. Differences are marked with ≠.')),
        h('div', { class: 'spacer' }),
        toggle('Only differences', diffOnly, (v) => {
          this.st.s.compareDiffOnly = v;
          this.st.changed('detail');
        }),
        button({ label: 'Clear selection', variant: 'ghost', onClick: () => this.st.setSelected([]) }),
      ),
      runs.length > shown.length ? h('div', { class: 'muted small' }, `Showing the first ${shown.length} of ${runs.length} selected runs.`) : '',
      strip,
      h('section', { class: 'panel' }, h('header', { class: 'panel-head' }, h('h2', {}, 'Parameters'), h('span', { class: 'muted small' }, `${nDiffParams} of ${params.length} differ`)), table(params)),
      h('section', { class: 'panel' }, h('header', { class: 'panel-head' }, h('h2', {}, 'Metrics'), h('span', { class: 'muted small' }, `${nDiffMetrics} of ${metrics.length} differ`)), table(metrics, sectionName)),
    );
  }
}
