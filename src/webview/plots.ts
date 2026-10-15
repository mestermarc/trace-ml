// Line view: metric toolbar (picker, selected-metric chips, x axis, log-y, smoothing) and one uPlot
// chart per metric with one line per selected run. Zoom is kept across live updates.
import { applyWidth, chartMenuButton, chartSize, heightScale, moveItem, type ChartSize } from './chartLayout';
import uPlot from 'uplot';
import { groupLabel } from '../model/analysis';
import { groupMeanSeries, plotGroups, spreadSeries } from '../model/groupAgg';
import { AUTO_ALL_MAX, DEFAULT_TOP_N, effectiveLineMode, parseTopN, resolveDirection, topLineKeys, type LineMode, type RankDir } from '../model/lineDisplay';
import { emaSmooth, seriesXY, type XMode } from '../model/metricSeries';
import type { RunSummary, SeriesPayload } from '../types';
import { cssVar, formatClock, formatNumber, h, palette, withAlpha } from './dom';
import { EXPORT_SCALE, composePng } from './pngExport';
import { MAX_PLOT_RUNS, seriesId, type AppState, type Area } from './state';
import { button, chip, emptyState, openPopover, toggle } from './ui';

const CHART_H = 230;
/** Line charts start a third of a row wide (half or full on narrower panels) at normal height. */
const LINE_SIZE: ChartSize = { w: 'small', h: 'normal' };
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

/**
 * One plotted line: a run, or (Plot by groups) the mean of a group's runs, or (Median + IQR) the
 * median of all plotted runs. `faint` runs are drawn thin and pale behind the median line.
 */
interface RunLine {
  key: string;
  name: string;
  color: string;
  x: number[];
  y: (number | null)[];
  total: number;
  /** Group / median lines: number of runs behind each point, by x. */
  nAt?: Map<number, number>;
  role?: 'faint' | 'median';
  /** Median line: 25th / 75th percentile at each x (the band). */
  lo?: (number | null)[];
  hi?: (number | null)[];
}

/** What one uPlot data column (after x) shows: a line's raw values, its main curve, or a band edge. */
interface ColMeta {
  line: number;
  kind: 'raw' | 'main' | 'lo' | 'hi';
}

/** A group of plotted runs (Plot by groups). */
export interface PlotGroup {
  label: string;
  color: string;
  runs: RunSummary[];
}

const LINE_MODES: readonly LineMode[] = ['auto', 'all', 'top', 'spread'];
const LINE_MODE_LABEL: Record<LineMode, string> = { auto: 'Auto', all: 'All runs', top: 'Top N', spread: 'Median + IQR' };

/** Line display settings, sanitized (the saved state may come from an older or edited file). */
export function lineDisplay(p: AppState['s']['plot']): { mode: LineMode; topN: number; rank: RankDir } {
  return {
    mode: LINE_MODES.includes(p.lineMode) ? p.lineMode : 'auto',
    topN: Number.isInteger(p.topN) && p.topN >= 1 && p.topN <= 100 ? p.topN : DEFAULT_TOP_N,
    rank: p.rank === 'min' || p.rank === 'max' ? p.rank : 'auto',
  };
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
  private cols: ColMeta[] = [];
  private focusedSeries = -1;
  private hotLine = -1;
  private noteKey = '';
  /** What the chart currently shows, so it can be re-rendered at export resolution. */
  private shown: { data: uPlot.AlignedData; xMode: XMode; logY: boolean; smooth: boolean } | null = null;
  /** Plot height in CSS px (the "⋯" menu's Height). */
  private height = CHART_H;

  constructor(readonly metric: string, onRemove: () => void, onExport: () => void, onData: () => void, layoutMenu: HTMLButtonElement) {
    this.info = h('span', { class: 'chart-info' });
    this.note = h('div', { class: 'chart-note' });
    this.body = h('div', { class: 'chart-body', title: 'Drag to zoom · double-click to reset · hover a line to highlight it' }, this.note);
    const remove = button({ icon: 'close', title: `Remove ${metric}`, variant: 'ghost', cls: 'chart-remove', onClick: onRemove });
    const png = button({ icon: 'download', title: `Save ${metric} as PNG (300 DPI)`, variant: 'ghost', cls: 'chart-remove', onClick: onExport });
    const data = button({ icon: 'file', title: `Save the data of ${metric} as CSV (full history, for agents)`, variant: 'ghost', cls: 'chart-remove', onClick: onData });
    this.el = h(
      'article',
      { class: 'chart-card', 'aria-label': `Chart ${metric}` },
      h('header', { class: 'chart-head' }, h('span', { class: 'chart-group' }, metricGroup(metric)), h('span', { class: 'chart-title' }, metricShort(metric)), h('span', { class: 'spacer' }), this.info, data, png, remove, layoutMenu),
      this.body,
    );
    new ResizeObserver(() => this.resize()).observe(this.body);
  }

  /** Applies the size chosen in the "⋯" menu (grid span and plot height). */
  setSize(size: ChartSize): void {
    applyWidth(this.el, size);
    const height = Math.round(CHART_H * heightScale(size.h));
    if (height === this.height) return;
    this.height = height;
    if (this.chart) this.chart.setSize({ width: this.chart.width, height });
  }

  update(st: AppState, runs: RunSummary[], themeVersion: number, colorFor: (run: RunSummary) => string, groups: PlotGroup[] | null = null): void {
    const { xMode, logY, smoothing, hidden } = st.s.plot;
    const display = lineDisplay(st.s.plot);
    const hiddenSet = new Set(hidden);
    let lines: RunLine[] = [];
    let loading = 0;
    let downsampled = 0;
    let modeInfo = '';
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
    const payloads: SeriesPayload[] = [];
    for (const run of groups ? [] : runs) {
      if (hiddenSet.has(run.key)) continue;
      const p = st.series.get(seriesId(run.key, this.metric));
      if (!p) {
        loading++;
        continue;
      }
      const l: RunLine = { key: run.key, name: run.name, color: colorFor(run), ...seriesXY(p, xMode, logY), total: p.total };
      if (l.x.length === 0) continue;
      if (l.total > l.y.length) downsampled++;
      lines.push(l);
      payloads.push(p);
    }
    // Many runs: draw the best N for this metric, or a median + IQR band over faint run lines.
    // The focused run (table click / legend double-click) is always drawn as a full line.
    const mode = groups ? 'all' : effectiveLineMode(display.mode, lines.length);
    const focused = st.s.focused;
    if (mode === 'top' && lines.length > display.topN) {
      const dir = resolveDirection(display.rank, this.metric);
      const keep = new Set(topLineKeys(lines, display.topN, dir));
      if (focused) keep.add(focused);
      const total = lines.length;
      lines = lines.filter((l) => keep.has(l.key));
      modeInfo = `top ${Math.min(display.topN, total)} of ${total} (${dir === 'min' ? 'lowest' : 'highest'} final)`;
    } else if (mode === 'spread' && lines.length > 1) {
      const s = spreadSeries(payloads, xMode, logY);
      const runLines = lines.map((l): RunLine => (l.key === focused ? l : { ...l, role: 'faint' }));
      const median: RunLine = { key: 'median', name: `median of ${lines.length} runs`, color: cssVar('--tm-text', '#e4e7ec'), x: s.x, y: s.median, lo: s.lo, hi: s.hi, total: s.x.length, nAt: new Map(s.x.map((x, i) => [x, s.n[i]!])), role: 'median' };
      // the focused run goes last so it is drawn on top of the band
      const focusLine = runLines.find((l) => l.key === focused && !l.role);
      lines = [...runLines.filter((l) => l !== focusLine), median, ...(focusLine ? [focusLine] : [])];
      modeInfo = `median + IQR of ${payloads.length} runs`;
    }
    this.lines = lines;

    const points = lines.reduce((a, l) => a + l.x.length, 0);
    const counted = lines.filter((l) => l.role !== 'median').length;
    this.info.textContent = [modeInfo || (counted ? `${counted} ${groups ? 'group' : 'run'}${counted === 1 ? '' : 's'}` : ''), downsampled ? 'downsampled' : '', loading && lines.length ? `loading ${loading}…` : '']
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
    const { data, cols } = this.layout(lines, smoothing);
    this.cols = cols;
    const xs = data[0] as number[];
    const extent: [number, number] | null = xs.length ? [xs[0]!, xs[xs.length - 1]!] : null;

    this.shown = { data, xMode, logY, smooth };
    const sig = JSON.stringify([xMode, logY, smooth, lines.map((l) => [l.key, l.color, l.name, l.role]), themeVersion]);
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
    this.chart = new uPlot(this.options(lines, cols, xMode, logY, width), data, this.body);
    this.tooltip = h('div', { class: 'chart-tooltip', role: 'tooltip' });
    this.tooltip.hidden = true;
    this.chart.over.append(this.tooltip);
  }

  /**
   * Data columns per line: raw + smoothed (smoothing on) or the values; faint run lines only their
   * curve; the median line its curve plus the band edges. Returns the joined data and what each
   * column (after x) shows.
   */
  private layout(lines: RunLine[], smoothing: number): { data: uPlot.AlignedData; cols: ColMeta[] } {
    const smooth = smoothing > 0;
    const sm = (y: (number | null)[]) => (smooth ? emaSmooth(y, smoothing) : y);
    const cols: ColMeta[] = [];
    const tables = lines.map((l, line) => {
      const t: (number | null)[][] = [];
      if (l.role === 'median') {
        t.push(sm(l.y), sm(l.lo ?? []), sm(l.hi ?? []));
        cols.push({ line, kind: 'main' }, { line, kind: 'lo' }, { line, kind: 'hi' });
      } else if (smooth && l.role !== 'faint') {
        t.push(l.y, sm(l.y));
        cols.push({ line, kind: 'raw' }, { line, kind: 'main' });
      } else {
        t.push(sm(l.y));
        cols.push({ line, kind: 'main' });
      }
      return [l.x, ...t] as uPlot.AlignedData;
    });
    return { data: tables.length === 1 ? tables[0]! : uPlot.join(tables), cols };
  }

  /** Stroke width and colour of a data column, normal and highlighted (hovered line). */
  private style(l: RunLine, c: ColMeta, smooth: boolean, k: number): { stroke: string; width: number; hot: { stroke: string; width: number } } {
    if (c.kind === 'lo' || c.kind === 'hi') return { stroke: 'transparent', width: 0, hot: { stroke: 'transparent', width: 0 } };
    if (c.kind === 'raw') return { stroke: withAlpha(l.color, 0.25), width: 1 * k, hot: { stroke: withAlpha(l.color, 0.45), width: 1.4 * k } };
    if (l.role === 'faint') return { stroke: withAlpha(l.color, 0.22), width: 1 * k, hot: { stroke: l.color, width: 2.6 * k } };
    const w = l.role === 'median' ? 2.4 : smooth ? 2 : l.nAt ? 2.2 : 1.6;
    return { stroke: l.color, width: w * k, hot: { stroke: l.color, width: (w + 1.6) * k } };
  }

  /**
   * uPlot options. `k` scales every size (fonts, strokes, axis sizes) for the PNG export, where the
   * chart is drawn `k` times larger than on screen.
   */
  private options(lines: RunLine[], cols: ColMeta[], xMode: XMode, logY: boolean, width: number, k = 1): uPlot.Options {
    const t = chartTheme();
    const smooth = cols.some((c) => c.kind === 'raw');
    const series: uPlot.Series[] = [{ label: X_LABEL[xMode] }];
    const bands: uPlot.Band[] = [];
    const styles = cols.map((c) => this.style(lines[c.line]!, c, smooth, k));
    cols.forEach((c, i) => {
      const l = lines[c.line]!;
      const st = styles[i]!;
      const label = c.kind === 'raw' ? `${l.name} (raw)` : c.kind === 'lo' ? `${l.name} 25%` : c.kind === 'hi' ? `${l.name} 75%` : l.name;
      const points = c.kind === 'main' && l.role !== 'faint' ? { size: 5 * k, fill: l.color } : { show: false };
      series.push({ label, stroke: st.stroke, width: st.width, points });
      if (c.kind === 'hi') bands.push({ series: [i + 1, i], fill: withAlpha(l.color, 0.16) });
    });
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
      height: this.height * k,
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
      bands,
      cursor: { sync: { key: 'traceml' }, drag: { x: true, y: false }, points: { size: 7 }, focus: { prox: 24 } },
      hooks: {
        setCursor: [(u) => this.showTooltip(u, xMode)],
        setSeries: [
          (u, idx) => {
            this.focusedSeries = idx ?? -1;
            this.highlight(u, idx ?? null, styles);
            this.showTooltip(u, xMode);
          },
        ],
      },
    };
  }

  /** Thickens (and, for faint run lines, brightens) the line under the cursor; the rest dims. */
  private highlight(u: uPlot, idx: number | null, styles: ReturnType<ChartCard['style']>[]): void {
    const line = idx !== null && idx > 0 ? (this.cols[idx - 1]?.line ?? -1) : -1;
    if (line === this.hotLine) return;
    this.hotLine = line;
    this.cols.forEach((c, i) => {
      const s = u.series[i + 1];
      const st = styles[i];
      if (!s || !st) return;
      const look = c.line === line ? st.hot : st;
      s.width = look.width;
      s.stroke = () => look.stroke;
    });
    u.redraw(false);
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
    const hotLine = this.focusedSeries > 0 ? (this.cols[this.focusedSeries - 1]?.line ?? -1) : -1;
    const at = (col: number) => (col < 0 ? undefined : u.data[col + 1]?.[idx]);
    this.lines.forEach((l, i) => {
      // Faint run lines (Median + IQR) are listed only while hovered; the median row stands for them.
      if (l.role === 'faint' && i !== hotLine) return;
      const col = (kind: ColMeta['kind']) => this.cols.findIndex((c) => c.line === i && c.kind === kind);
      const v = at(col('main'));
      if (v === undefined) return;
      const raw = at(col('raw'));
      const lo = at(col('lo'));
      const hi = at(col('hi'));
      rows.push(
        h(
          'div',
          { class: `tt-row${i === hotLine ? ' hot' : ''}` },
          h('span', { class: 'swatch', style: `background:${l.color}` }),
          h('span', { class: 'tt-name' }, l.name),
          h('span', { class: 'tt-val' }, v === null ? '—' : formatNumber(v)),
          lo !== undefined && lo !== null && hi !== undefined && hi !== null ? h('span', { class: 'tt-raw' }, `IQR ${formatNumber(lo)} – ${formatNumber(hi)}`) : null,
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
    const { data, xMode, logY } = this.shown;
    const width = this.chart.width;
    // uPlot already multiplies by the device pixel ratio; scale the rest so pixels = CSS px * 300/96.
    const pxRatio = (uPlot as unknown as { pxRatio?: number }).pxRatio || window.devicePixelRatio || 1;
    const k = EXPORT_SCALE / pxRatio;
    const opts = this.options(this.lines, this.cols, xMode, logY, width * k, k);
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
        height: this.height,
        legend: this.lines.flatMap((l) =>
          l.role === 'faint' ? [] : l.role === 'median' ? [{ color: l.color, label: l.name }, { color: withAlpha(l.color, 0.35), label: '25–75% of runs (IQR)' }] : [{ color: l.color, label: l.name }],
        ),
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
      if (Math.abs(w - this.chart.width) > 1) this.chart.setSize({ width: w, height: this.height });
    }
  }

  destroy(): void {
    this.chart?.destroy();
    this.chart = null;
    this.tooltip = null;
    this.sig = '';
    this.hotLine = -1;
    this.focusedSeries = -1;
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
    const field = this.st.s.plot.colorBy === 'group' ? this.st.groupField() : null;
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
    const display = lineDisplay(p);
    const key = JSON.stringify([p.xMode, p.logY, p.colorBy, p.byGroups, !!this.st.groupField(), display]);
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
    const colorBy = toggle('Colour by group', p.colorBy === 'group' && !!this.st.groupField(), (v) => {
      p.colorBy = v ? 'group' : 'run';
      this.st.changed('plots');
    }, this.st.groupField() ? 'Colour lines by the table grouping' : 'Group the table (Group) to colour lines by group');
    if (!this.st.groupField()) colorBy.classList.add('disabled');
    (colorBy.querySelector('input') as HTMLInputElement).disabled = !this.st.groupField();
    const byGroups = toggle('Plot by groups', p.byGroups && !!this.st.groupField(), (v) => {
      p.byGroups = v;
      this.st.changed('plots');
    }, this.st.groupField() ? 'One line per table group: the mean of its selected runs at each step' : 'Group the table (Group) to plot group means');
    if (!this.st.groupField()) byGroups.classList.add('disabled');
    (byGroups.querySelector('input') as HTMLInputElement).disabled = !this.st.groupField();
    // Lines: what to draw when many runs are plotted (ignored while plotting by groups).
    const grouped = p.byGroups && !!this.st.groupField();
    const modeSelect = h(
      'select',
      { 'aria-label': 'Lines', disabled: grouped },
      ...LINE_MODES.map((m) => h('option', { value: m, selected: display.mode === m }, m === 'auto' ? `Auto (all up to ${AUTO_ALL_MAX}, then top N)` : m === 'top' ? `Top ${display.topN}` : LINE_MODE_LABEL[m])),
    );
    modeSelect.value = display.mode;
    modeSelect.addEventListener('change', () => {
      p.lineMode = modeSelect.value as LineMode;
      this.st.changed('plots');
    });
    const ranked = display.mode === 'top' || display.mode === 'auto';
    const topInput = h('input', { type: 'number', min: 1, max: 100, step: 1, value: display.topN, class: 'num-input', 'aria-label': 'Number of best runs to draw', disabled: grouped });
    topInput.addEventListener('change', () => {
      const n = parseTopN(topInput.value);
      if (n === null) topInput.value = String(display.topN);
      else {
        p.topN = n;
        this.st.changed('plots');
      }
    });
    const rankSelect = h(
      'select',
      { 'aria-label': 'Best runs are', disabled: grouped },
      h('option', { value: 'auto', selected: display.rank === 'auto' }, 'auto (lower for loss / error)'),
      h('option', { value: 'min', selected: display.rank === 'min' }, 'lowest final'),
      h('option', { value: 'max', selected: display.rank === 'max' }, 'highest final'),
    );
    rankSelect.value = display.rank;
    rankSelect.addEventListener('change', () => {
      p.rank = rankSelect.value as RankDir;
      this.st.changed('plots');
    });
    const linesTitle = grouped
      ? 'Plot by groups draws one mean line per group'
      : 'Many runs: draw only the best N per chart (by final value), or the median with the 25–75% band over faint run lines. The focused run (click a row) is always drawn; hover a line to highlight it.';
    this.controls.replaceChildren(
      h('label', { class: 'field', title: linesTitle }, h('span', { class: 'field-label' }, 'Lines'), modeSelect),
      ranked ? h('label', { class: 'field', title: 'How many runs Top N draws per chart' }, h('span', { class: 'field-label' }, 'N'), topInput) : '',
      ranked ? h('label', { class: 'field', title: 'Which final values count as best for Top N' }, h('span', { class: 'field-label' }, 'Best'), rankSelect) : '',
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
    const field = this.st.groupField();
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
        h('span', { class: 'muted small' }, `Mean per ${this.st.fieldLabel(this.st.groupField()!)}:`),
        ...groups.map((g) => {
          const n = g.runs.filter((r) => !hidden.has(r.key)).length;
          return h('span', { class: 'legend-item static', title: g.runs.map((r) => r.name).join('\n') }, h('span', { class: 'swatch', style: `background:${g.color}` }), h('span', { class: 'legend-name' }, g.label), h('span', { class: 'muted' }, `${n} run${n === 1 ? '' : 's'}`));
        }),
      );
      this.legend.hidden = false;
      return;
    }
    const colorFor = this.colorResolver();
    const groupField = this.st.s.plot.colorBy === 'group' ? this.st.groupField() : null;
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
          chartMenuButton({
            st: this.st,
            id: `line:${m}`,
            name: m,
            defaults: LINE_SIZE,
            position: () => ({ index: this.st.plotMetrics().indexOf(m), count: this.st.plotMetrics().length }),
            onMove: (to) => {
              const ms = this.st.plotMetrics();
              this.setMetrics(moveItem(ms, ms.indexOf(m), to));
            },
          }),
        );
        card = c;
        this.cards.set(m, card);
      }
      if (this.grid.children[i] !== card.el) this.grid.insertBefore(card.el, this.grid.children[i] ?? null);
      card.setSize(chartSize(this.st, `line:${m}`, LINE_SIZE));
      card.update(this.st, runs, this.themeVersion, colorFor, groups);
    });
  }
}

