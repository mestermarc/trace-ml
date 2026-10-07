// Line view: metric toolbar (picker, selected-metric chips, x axis, log-y, smoothing) and one uPlot
// chart per metric with one line per selected run. Zoom is kept across live updates.
import uPlot from 'uplot';
import { groupLabel } from '../model/analysis';
import { groupMeanSeries, plotGroups } from '../model/groupAgg';
import { emaSmooth, seriesXY, type XMode } from '../model/metricSeries';
import type { RunSummary } from '../types';
import { cssVar, formatClock, formatNumber, h, palette, withAlpha } from './dom';
import { EXPORT_SCALE, composePng } from './pngExport';
import { MAX_PLOT_RUNS, seriesId, type AppState, type Area } from './state';
import { button, chip, emptyState, openPopover, toggle } from './ui';

const CHART_H = 230;
const X_LABEL: Record<XMode, string> = { step: 'Step', epoch: 'Epoch', wall: 'Wall time' };

/** Section name used by the metric picker: `train/loss` -> `train`, `sys/gpu` -> `system`. */
export function metricGroup(name: string): string {
  const i = name.indexOf('/');
  const g = i > 0 ? name.slice(0, i) : 'other';
  return g === 'sys' ? 'system' : g;
}

function metricShort(name: string): string {
  const i = name.indexOf('/');
  return i > 0 ? name.slice(i + 1) : name;
}

/** Chart colours/fonts derived from the design tokens. */
export function chartTheme() {
  return {
    axis: cssVar('--tm-chart-axis', '#7d8593'),
    grid: cssVar('--tm-chart-grid', 'rgba(255,255,255,0.06)'),
    text: cssVar('--tm-text-secondary', '#aab1bd'),
    font: `11px ${cssVar('--tm-font', 'sans-serif')}`,
    select: cssVar('--tm-accent-soft', 'rgba(76,141,255,0.14)'),
  };
}

/** One plotted line: a run, or (Plot by groups) the mean of a group's runs. */
interface RunLine {
  key: string;
  name: string;
  color: string;
  x: number[];
  y: (number | null)[];
  total: number;
  /** Group lines: number of runs behind each point, by x. */
  nAt?: Map<number, number>;
}

/** A group of plotted runs (Plot by groups). */
export interface PlotGroup {
  label: string;
  color: string;
  runs: RunSummary[];
}

function runLine(st: AppState, run: RunSummary, metric: string, xMode: XMode, logY: boolean, color: string): RunLine | null {
  const p = st.series.get(seriesId(run.key, metric));
  if (!p) return null;
  return { key: run.key, name: run.name, color, ...seriesXY(p, xMode, logY), total: p.total };
}

class ChartCard {
  readonly el: HTMLElement;
  private readonly body: HTMLElement;
  private readonly info: HTMLElement;
  private readonly note: HTMLElement;
  private chart: uPlot | null = null;
  private sig = '';
  private extent: [number, number] | null = null;
  private tooltip: HTMLElement | null = null;
  private lines: RunLine[] = [];
  private smoothing = 0;
  private focusedSeries = -1;
  private noteKey = '';
  /** What the chart currently shows, so it can be re-rendered at export resolution. */
  private shown: { data: uPlot.AlignedData; xMode: XMode; logY: boolean; smooth: boolean } | null = null;

  constructor(readonly metric: string, onRemove: () => void, onExport: () => void, onData: () => void) {
    this.info = h('span', { class: 'chart-info' });
    this.note = h('div', { class: 'chart-note' });
    this.body = h('div', { class: 'chart-body', title: 'Drag to zoom · double-click to reset' }, this.note);
    const remove = button({ icon: 'close', title: `Remove ${metric}`, variant: 'ghost', cls: 'chart-remove', onClick: onRemove });
    const png = button({ icon: 'download', title: `Save ${metric} as PNG (300 DPI)`, variant: 'ghost', cls: 'chart-remove', onClick: onExport });
    const data = button({ icon: 'file', title: `Save the data of ${metric} as CSV (full history, for agents)`, variant: 'ghost', cls: 'chart-remove', onClick: onData });
    this.el = h(
      'article',
      { class: 'chart-card', 'aria-label': `Chart ${metric}` },
      h('header', { class: 'chart-head' }, h('span', { class: 'chart-group' }, metricGroup(metric)), h('span', { class: 'chart-title' }, metricShort(metric)), h('span', { class: 'spacer' }), this.info, data, png, remove),
      this.body,
    );
  }

  update(st: AppState, runs: RunSummary[], themeVersion: number, colorFor: (run: RunSummary) => string, groups: PlotGroup[] | null = null): void {
    const { xMode, logY, smoothing, hidden } = st.s.plot;
    const hiddenSet = new Set(hidden);
    const lines: RunLine[] = [];
    let loading = 0;
    let downsampled = 0;
    // Plot by groups: one line per group, the mean of its runs at each step.
    for (const g of groups ?? []) {
      const series = [];
      let missing = 0;
      for (const run of g.runs) {
        if (hiddenSet.has(run.key)) continue;
        const p = st.series.get(seriesId(run.key, this.metric));
        if (!p) missing++;
        else {
          series.push(p);
          if (p.total > p.y.length) downsampled++;
        }
      }
      if (missing) loading++;
      if (!series.length) continue;
      const m = groupMeanSeries(series, xMode, logY);
      if (!m.x.length) continue;
      lines.push({ key: `group:${g.label}`, name: `${g.label} (mean of ${series.length})`, color: g.color, x: m.x, y: m.y, total: m.x.length, nAt: new Map(m.x.map((x, i) => [x, m.n[i]!])) });
    }
    for (const run of groups ? [] : runs) {
      if (hiddenSet.has(run.key)) continue;
      const l = runLine(st, run, this.metric, xMode, logY, colorFor(run));
      if (!l) {
        loading++;
        continue;
      }
      if (l.x.length === 0) continue;
      if (l.total > l.y.length) downsampled++;
      lines.push(l);
    }
    this.lines = lines;
    this.smoothing = smoothing;

    const points = lines.reduce((a, l) => a + l.x.length, 0);
    this.info.textContent = [lines.length ? `${lines.length} ${groups ? 'group' : 'run'}${lines.length === 1 ? '' : 's'}` : '', downsampled ? 'downsampled' : '', loading && lines.length ? `loading ${loading}…` : '']
      .filter(Boolean)
      .join(' · ');
    this.info.title = `${points} points drawn${downsampled ? `; series longer than ${st.config.maxPointsPerSeries} points use min/max-preserving downsampling` : ''}`;

    if (lines.length === 0) {
      this.shown = null;
      this.destroy();
      const key = loading ? 'loading' : 'none';
      if (key !== this.noteKey) {
        this.noteKey = key;
        this.note.replaceChildren(
          loading
            ? h('div', { class: 'chart-skeleton', 'aria-label': 'Loading series' })
            : emptyState({ compact: true, icon: 'chart', title: 'No metrics available', text: `None of the plotted runs has ${this.metric} in a readable metrics.jsonl.` }),
        );
      }
      this.note.hidden = false;
      return;
    }
    this.noteKey = '';
    this.note.hidden = true;

    const smooth = smoothing > 0;
    const tables: uPlot.AlignedData[] = lines.map((l) => (smooth ? [l.x, l.y, emaSmooth(l.y, smoothing)] : [l.x, l.y]) as uPlot.AlignedData);
    const data = tables.length === 1 ? tables[0]! : uPlot.join(tables);
    const xs = data[0] as number[];
    const extent: [number, number] | null = xs.length ? [xs[0]!, xs[xs.length - 1]!] : null;

    this.shown = { data, xMode, logY, smooth };
    const sig = JSON.stringify([xMode, logY, smooth, lines.map((l) => [l.key, l.color, l.name]), themeVersion]);
    const width = Math.max(200, this.body.clientWidth || 400);
    if (this.chart && sig === this.sig) {
      // Live update: keep the user's zoom if they zoomed in, otherwise follow the growing data.
      const sx = this.chart.scales.x;
      const prev = this.extent;
      const eps = prev ? Math.abs(prev[1] - prev[0]) * 1e-9 : 0;
      const zoomed = prev !== null && sx?.min != null && sx.max != null && (sx.min > prev[0] + eps || sx.max < prev[1] - eps);
      this.chart.setData(data, !zoomed);
      this.extent = extent;
      return;
    }
    this.destroy();
    this.sig = sig;
    this.extent = extent;
    this.chart = new uPlot(this.options(lines, xMode, logY, smooth, width), data, this.body);
    this.tooltip = h('div', { class: 'chart-tooltip', role: 'tooltip' });
    this.tooltip.hidden = true;
    this.chart.over.append(this.tooltip);
  }

  /**
   * uPlot options. `k` scales every size (fonts, strokes, axis sizes) for the PNG export, where the
   * chart is drawn `k` times larger than on screen.
   */
  private options(lines: RunLine[], xMode: XMode, logY: boolean, smooth: boolean, width: number, k = 1): uPlot.Options {
    const t = chartTheme();
    const series: uPlot.Series[] = [{ label: X_LABEL[xMode] }];
    for (const l of lines) {
      if (smooth) series.push({ label: `${l.name} (raw)`, stroke: withAlpha(l.color, 0.25), width: 1 * k, points: { show: false } });
      series.push({ label: l.name, stroke: l.color, width: (smooth ? 2 : l.nAt ? 2.2 : 1.6) * k, points: { size: 5 * k, fill: l.color } });
    }
    const axis = (values?: uPlot.Axis['values']): uPlot.Axis => ({
      stroke: t.axis,
      font: t.font.replace(/(\d+(?:\.\d+)?)px/, (_m, n: string) => `${Number(n) * k}px`),
      grid: { stroke: t.grid, width: 1 * k },
      ticks: { show: false },
      border: { show: false },
      gap: 5 * k,
      values,
    });
    return {
      width,
      height: CHART_H * k,
      legend: { show: false },
      focus: { alpha: 0.28 },
      padding: [10 * k, 8 * k, 0, 0],
      scales: { x: { time: false }, y: { distr: logY ? 3 : 1 } },
      axes: [
        // `space` = min px between ticks (uPlot defaults 50 / 30), scaled so the PNG keeps the on-screen tick density
        { ...axis(xMode === 'wall' ? (_u, vals) => vals.map((v) => (v === null ? '' : formatClock(v))) : undefined), size: 34 * k, space: 50 * k },
        { ...axis((_u, vals) => vals.map((v) => (v === null ? '' : formatNumber(v)))), size: 54 * k, space: 30 * k },
      ],
      series,
      cursor: { sync: { key: 'traceml' }, drag: { x: true, y: false }, points: { size: 7 }, focus: { prox: 24 } },
      hooks: {
        setCursor: [(u) => this.showTooltip(u, xMode)],
        setSeries: [
          (u, idx) => {
            this.focusedSeries = idx ?? -1;
            this.showTooltip(u, xMode);
          },
        ],
      },
    };
  }

  private showTooltip(u: uPlot, xMode: XMode): void {
    const tip = this.tooltip;
    if (!tip) return;
    const idx = u.cursor.idx;
    if (idx === null || idx === undefined || u.cursor.left === undefined || u.cursor.left < 0) {
      tip.hidden = true;
      return;
    }
    const x = u.data[0][idx];
    const rows: Node[] = [h('div', { class: 'tt-x' }, `${X_LABEL[xMode]} ${x === undefined || x === null ? '' : xMode === 'wall' ? formatClock(x) : formatNumber(x)}`)];
    const perRun = this.smoothing > 0 ? 2 : 1;
    this.lines.forEach((l, i) => {
      const smoothedCol = 1 + i * perRun + (perRun - 1);
      const rawCol = 1 + i * perRun;
      const v = u.data[smoothedCol]?.[idx];
      if (v === undefined) return;
      const raw = perRun === 2 ? u.data[rawCol]?.[idx] : undefined;
      const hot = this.focusedSeries === smoothedCol || this.focusedSeries === rawCol;
      rows.push(
        h(
          'div',
          { class: `tt-row${hot ? ' hot' : ''}` },
          h('span', { class: 'swatch', style: `background:${l.color}` }),
          h('span', { class: 'tt-name' }, l.name),
          h('span', { class: 'tt-val' }, v === null ? '—' : formatNumber(v)),
          l.nAt && typeof x === 'number' && l.nAt.has(x) ? h('span', { class: 'tt-raw' }, `n=${l.nAt.get(x)}`) : null,
          raw !== undefined && raw !== null ? h('span', { class: 'tt-raw' }, formatNumber(raw)) : null,
        ),
      );
    });
    if (rows.length === 1) {
      tip.hidden = true;
      return;
    }
    tip.replaceChildren(...rows);
    tip.hidden = false;
    const left = u.cursor.left ?? 0;
    const top = u.cursor.top ?? 0;
    const w = tip.offsetWidth;
    const overW = u.over.clientWidth;
    tip.style.left = `${left + 16 + w > overW ? Math.max(0, left - w - 16) : left + 16}px`;
    tip.style.top = `${Math.max(0, Math.min(top + 12, u.over.clientHeight - tip.offsetHeight))}px`;
  }

  /**
   * Renders the chart off-screen at 300 DPI (keeping the current zoom) and returns the composed PNG
   * as base64, or null when there is nothing to export.
   */
  async toPng(subtitle: string): Promise<string | null> {
    if (!this.chart || !this.shown) return null;
    const { data, xMode, logY, smooth } = this.shown;
    const width = this.chart.width;
    // uPlot already multiplies by the device pixel ratio; scale the rest so pixels = CSS px * 300/96.
    const pxRatio = (uPlot as unknown as { pxRatio?: number }).pxRatio || window.devicePixelRatio || 1;
    const k = EXPORT_SCALE / pxRatio;
    const opts = this.options(this.lines, xMode, logY, smooth, width * k, k);
    const sx = this.chart.scales.x;
    const sy = this.chart.scales.y;
    opts.cursor = { show: false };
    opts.hooks = {};
    const host = h('div', { class: 'png-render', 'aria-hidden': 'true' });
    document.body.append(host);
    try {
      const drawn = new Promise<void>((resolve) => {
        opts.hooks = { draw: [() => resolve()] };
        setTimeout(resolve, 2000);
      });
      const u = new uPlot(opts, data, host);
      if (sx?.min != null && sx.max != null) u.setScale('x', { min: sx.min, max: sx.max });
      if (sy?.min != null && sy.max != null && !logY) u.setScale('y', { min: sy.min, max: sy.max });
      await drawn;
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const png = composePng({
        title: this.metric,
        subtitle,
        chart: u.ctx.canvas,
        width,
        height: CHART_H,
        legend: this.lines.map((l) => ({ color: l.color, label: l.name })),
      });
      u.destroy();
      return png;
    } finally {
      host.remove();
    }
  }

  resize(): void {
    if (this.chart) {
      const w = Math.max(200, this.body.clientWidth);
      if (Math.abs(w - this.chart.width) > 1) this.chart.setSize({ width: w, height: CHART_H });
    }
  }

  destroy(): void {
    this.chart?.destroy();
    this.chart = null;
    this.tooltip = null;
    this.sig = '';
  }
}

export class Plots {
  readonly el: HTMLElement;
  private readonly addBtn: HTMLButtonElement;
  private readonly selectedChips = h('div', { class: 'metric-chips', 'aria-label': 'Plotted metrics' });
  private readonly controls = h('div', { class: 'viz-controls' });
  private readonly legend = h('div', { class: 'plot-legend', 'aria-label': 'Plotted runs' });
  private readonly grid = h('div', { class: 'chart-grid' });
  private readonly hint = h('div', { class: 'viz-empty' });
  private readonly cards = new Map<string, ChartCard>();
  private themeVersion = 0;
  private chipsKey = '';
  private legendKey = '';
  private controlsKey = '';
  private hintKey = '';
  private pickerFilter = '';

  constructor(private readonly st: AppState) {
    this.addBtn = button({ label: 'Metrics', icon: 'plus', title: 'Choose metrics to plot', onClick: () => this.openPicker() });
    this.addBtn.setAttribute('aria-haspopup', 'true');
    this.el = h(
      'div',
      { class: 'line-view' },
      h('div', { class: 'viz-toolbar' }, this.addBtn, this.selectedChips, h('div', { class: 'spacer' }), this.controls),
      this.legend,
      this.hint,
      this.grid,
    );
    new ResizeObserver(() => {
      for (const c of this.cards.values()) c.resize();
    }).observe(this.grid);
  }

  private setMetrics(ms: string[]): void {
    this.st.s.plot.metrics = ms;
    this.st.changed('plots');
    this.st.requestSeries();
  }

  // -- metric picker ---------------------------------------------------------------

  private openPicker(): void {
    const body = h('div', { class: 'pop-body metric-picker' });
    const render = () => {
      const selected = new Set(this.st.plotMetrics());
      const names = [...new Set([...this.st.availableMetrics(), ...selected])].sort();
      const needle = this.pickerFilter.toLowerCase();
      const groups = new Map<string, string[]>();
      for (const n of names) {
        if (needle && !n.toLowerCase().includes(needle)) continue;
        const g = metricGroup(n);
        groups.set(g, [...(groups.get(g) ?? []), n]);
      }
      const order = (g: string) => ['train', 'val', 'test', 'system', 'other'].indexOf(g) + 1 || 5;
      const search = h('input', { type: 'search', placeholder: 'Search metrics…', value: this.pickerFilter, spellcheck: 'false', 'aria-label': 'Search metrics' });
      search.addEventListener('input', () => {
        this.pickerFilter = search.value;
        render();
        const again = body.querySelector<HTMLInputElement>('input[type=search]');
        again?.focus();
        again?.setSelectionRange(again.value.length, again.value.length);
      });
      body.replaceChildren(
        h('div', { class: 'chooser-head' }, search),
        names.length
          ? h(
              'div',
              { class: 'metric-groups' },
              ...[...groups]
                .sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0]))
                .map(([g, ms]) =>
                  h(
                    'section',
                    { class: 'metric-group' },
                    h('div', { class: 'menu-header' }, g.toUpperCase()),
                    ...ms.map((m) => {
                      const cb = h('input', { type: 'checkbox', checked: selected.has(m) });
                      cb.addEventListener('change', () => {
                        const cur = this.st.plotMetrics().filter((x) => x !== m);
                        if (cb.checked) cur.push(m);
                        this.setMetrics(cur);
                      });
                      return h('label', { class: 'check metric-item', title: m }, cb, h('span', {}, g === 'other' ? m : metricShort(m)));
                    }),
                  ),
                ),
            )
          : h('div', { class: 'muted pop-note' }, 'No metrics known yet. Select runs that have metrics.json or metrics.jsonl.'),
      );
    };
    render();
    openPopover(this.addBtn, body, { width: 340, label: 'Choose metrics' });
  }

  // -- rendering ---------------------------------------------------------------------

  /** Line colour of a run: its stable run colour, or its group's colour when colouring by group. */
  private colorResolver(): (run: RunSummary) => string {
    const colors = palette();
    const field = this.st.s.plot.colorBy === 'group' ? this.st.s.groupBy : null;
    if (!field) return (run) => colors[this.st.colorIndex(run.key)] ?? '#888';
    const idx = this.st.groupColorIndex(field, [...this.st.filteredRuns(), ...this.st.plottedRuns()]);
    return (run) => colors[idx.get(groupLabel(run, field)) ?? 0] ?? '#888';
  }

  render(areas: Set<Area>): void {
    const structural = areas.has('runs') || areas.has('selection') || areas.has('plots') || areas.has('nav');
    if (structural) {
      this.renderChips();
      this.renderControls();
      this.renderLegend();
    }
    if (structural || areas.has('series')) this.renderCharts();
  }

  private renderChips(): void {
    const ms = this.st.plotMetrics();
    const key = JSON.stringify([ms, this.st.s.plot.metrics === null]);
    if (key === this.chipsKey) return;
    this.chipsKey = key;
    this.selectedChips.replaceChildren(
      ...ms.map((m) => chip(m, () => this.setMetrics(this.st.plotMetrics().filter((x) => x !== m)), { title: m })),
      this.st.s.plot.metrics !== null
        ? button({
            label: 'Defaults',
            variant: 'ghost',
            cls: 'btn-small',
            title: 'Reset to the default metrics',
            onClick: () => {
              this.st.s.plot.metrics = null;
              this.st.changed('plots');
              this.st.requestSeries();
            },
          })
        : '',
    );
  }

  private renderControls(): void {
    const p = this.st.s.plot;
    const key = JSON.stringify([p.xMode, p.logY, p.colorBy, p.byGroups, !!this.st.s.groupBy]);
    if (key === this.controlsKey) return;
    this.controlsKey = key;
    const xSelect = h('select', { 'aria-label': 'X axis' }, ...(['step', 'epoch', 'wall'] as XMode[]).map((m) => h('option', { value: m, selected: p.xMode === m }, X_LABEL[m])));
    xSelect.value = p.xMode;
    xSelect.addEventListener('change', () => {
      p.xMode = xSelect.value as XMode;
      this.st.changed('series', 'plots');
    });
    const smoothing = h('input', { type: 'range', min: 0, max: 0.99, step: 0.01, value: p.smoothing, 'aria-label': 'EMA smoothing', class: 'range' });
    const smoothingValue = h('span', { class: 'range-value' }, p.smoothing.toFixed(2));
    smoothing.addEventListener('input', () => {
      p.smoothing = Number(smoothing.value);
      smoothingValue.textContent = p.smoothing.toFixed(2);
      this.st.changed('series');
    });
    // Shown on only while there is a grouping to colour by (the choice is kept for the next grouping).
    const colorBy = toggle('Colour by group', p.colorBy === 'group' && !!this.st.s.groupBy, (v) => {
      p.colorBy = v ? 'group' : 'run';
      this.st.changed('plots');
    }, this.st.s.groupBy ? 'Colour lines by the table grouping' : 'Group the table (Group) to colour lines by group');
    if (!this.st.s.groupBy) colorBy.classList.add('disabled');
    (colorBy.querySelector('input') as HTMLInputElement).disabled = !this.st.s.groupBy;
    const byGroups = toggle('Plot by groups', p.byGroups && !!this.st.s.groupBy, (v) => {
      p.byGroups = v;
      this.st.changed('plots');
    }, this.st.s.groupBy ? 'One line per table group: the mean of its selected runs at each step' : 'Group the table (Group) to plot group means');
    if (!this.st.s.groupBy) byGroups.classList.add('disabled');
    (byGroups.querySelector('input') as HTMLInputElement).disabled = !this.st.s.groupBy;
    this.controls.replaceChildren(
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'X'), xSelect),
      toggle('Log Y', p.logY, (v) => {
        p.logY = v;
        this.st.changed('series', 'plots');
      }),
      h('label', { class: 'field', title: 'Exponential moving average; the raw line stays faintly visible' }, h('span', { class: 'field-label' }, 'Smoothing'), smoothing, smoothingValue),
      colorBy,
      byGroups,
    );
  }

  /** Saves one chart as a 300 DPI PNG in TraceML's cache folder. */
  private async exportCard(card: ChartCard): Promise<void> {
    const p = this.st.s.plot;
    const subtitle = [`x: ${X_LABEL[p.xMode].toLowerCase()}`, p.logY ? 'log y' : '', p.smoothing > 0 ? `smoothing ${p.smoothing}` : ''].filter(Boolean).join(' · ');
    try {
      const png = await card.toPng(subtitle);
      if (png) this.st.savePlot(card.metric, png);
      else this.st.showError('Nothing to export: the chart has no data yet.');
    } catch (e) {
      this.st.showError(`Could not render the PNG: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** Plot by groups is on and there is a grouping: the groups of the plotted runs, with colours. */
  private plotGroups(): PlotGroup[] | null {
    const field = this.st.s.groupBy;
    if (!this.st.s.plot.byGroups || !field) return null;
    const colors = palette();
    const idx = this.st.groupColorIndex(field, [...this.st.filteredRuns(), ...this.st.plottedRuns()]);
    return plotGroups(this.st.plottedRuns(), field).map((g) => ({ ...g, color: colors[idx.get(g.label) ?? 0] ?? '#888' }));
  }

  private renderLegend(): void {
    const groups = this.plotGroups();
    if (groups) {
      // group legend: colour, group, number of runs averaged (hidden runs are left out)
      const hidden = new Set(this.st.s.plot.hidden);
      const key = JSON.stringify(['groups', groups.map((g) => [g.label, g.color, g.runs.map((r) => r.key)]), [...hidden], this.themeVersion]);
      if (key === this.legendKey) return;
      this.legendKey = key;
      this.legend.replaceChildren(
        h('span', { class: 'muted small' }, `Mean per ${this.st.fieldLabel(this.st.s.groupBy!)}:`),
        ...groups.map((g) => {
          const n = g.runs.filter((r) => !hidden.has(r.key)).length;
          return h('span', { class: 'legend-item static', title: g.runs.map((r) => r.name).join('\n') }, h('span', { class: 'swatch', style: `background:${g.color}` }), h('span', { class: 'legend-name' }, g.label), h('span', { class: 'muted' }, `${n} run${n === 1 ? '' : 's'}`));
        }),
      );
      this.legend.hidden = false;
      return;
    }
    const colorFor = this.colorResolver();
    const groupField = this.st.s.plot.colorBy === 'group' ? this.st.s.groupBy : null;
    const hidden = new Set(this.st.s.plot.hidden);
    const runs = this.st.plottedRuns();
    const key = JSON.stringify([runs.map((r) => [r.key, r.name, colorFor(r)]), [...hidden], this.st.selectedRuns().length, groupField, this.themeVersion, this.st.s.focused]);
    if (key === this.legendKey) return;
    this.legendKey = key;
    const items = runs.map((r) => {
      const off = hidden.has(r.key);
      const b = h(
        'button',
        { type: 'button', class: `legend-item${off ? ' off' : ''}${r.key === this.st.s.focused ? ' focused' : ''}`, title: `${r.id}\nClick to ${off ? 'show' : 'hide'} · double-click for details`, 'aria-pressed': off ? 'false' : 'true' },
        h('span', { class: 'swatch', style: `background:${colorFor(r)}` }),
        h('span', { class: 'legend-name' }, r.name),
        groupField ? h('span', { class: 'muted' }, groupLabel(r, groupField)) : null,
      );
      b.addEventListener('click', () => {
        const next = new Set(this.st.s.plot.hidden);
        if (next.has(r.key)) next.delete(r.key);
        else next.add(r.key);
        this.st.s.plot.hidden = [...next].filter((k) => this.st.runs.has(k));
        this.st.changed('plots');
      });
      b.addEventListener('dblclick', () => this.st.focus(r.key));
      return b;
    });
    const extra = this.st.selectedRuns().length - runs.length;
    this.legend.replaceChildren(...items, extra > 0 ? h('span', { class: 'muted small' }, `+${extra} selected runs not plotted (max ${MAX_PLOT_RUNS})`) : '');
    this.legend.hidden = runs.length === 0;
  }

  private renderCharts(): void {
    const runs = this.st.plottedRuns();
    const groups = this.plotGroups();
    const metrics = this.st.plotMetrics();
    const colorFor = this.colorResolver();
    const hintKey = !runs.length ? 'nosel' : !metrics.length ? 'nometric' : '';
    if (hintKey !== this.hintKey) {
      this.hintKey = hintKey;
      this.hint.replaceChildren(
        hintKey === 'nosel'
          ? emptyState({ icon: 'chart', title: 'Select experiments', text: 'Choose one or more runs in the table (checkboxes) to plot their metrics.' })
          : hintKey === 'nometric'
            ? emptyState({ icon: 'chart', title: 'No metrics chosen', text: 'Pick metrics to plot.', action: { label: 'Choose metrics', icon: 'plus', onClick: () => this.openPicker() } })
            : '',
      );
      this.hint.hidden = !hintKey;
    }

    const wanted = runs.length ? metrics : [];
    for (const [m, card] of this.cards) {
      if (!wanted.includes(m)) {
        card.destroy();
        card.el.remove();
        this.cards.delete(m);
      }
    }
    wanted.forEach((m, i) => {
      let card = this.cards.get(m);
      if (!card) {
        const c: ChartCard = new ChartCard(
          m,
          () => this.setMetrics(this.st.plotMetrics().filter((x) => x !== m)),
          () => void this.exportCard(c),
          () => {
            const hidden = new Set(this.st.s.plot.hidden);
            const keys = this.st.plottedRuns().filter((r) => !hidden.has(r.key)).map((r) => r.key);
            const groups = this.plotGroups();
            this.st.saveLineData(m, keys, groups ? Object.fromEntries(groups.flatMap((g) => g.runs.map((r) => [r.key, g.label]))) : undefined);
          },
        );
        card = c;
        this.cards.set(m, card);
      }
      if (this.grid.children[i] !== card.el) this.grid.insertBefore(card.el, this.grid.children[i] ?? null);
      card.update(this.st, runs, this.themeVersion, colorFor, groups);
    });
  }
}

