// Visualizations, stacked: Line (metric history of the selected runs) followed by the run-level
// Scatter, Box and Bar charts of the filtered runs. Each section is collapsible and remembers
// its state. Run-level charts use only data already in the webview (params + metrics.json
// summaries); they never request metrics.jsonl histories.
import { barData, boxData, logTicks, niceTicks, NONE_GROUP, scatterData, type BarData, type BoxData, type ScatterData } from '../model/analysis';
import { parseColumnId } from '../model/run';
import { cssVar, formatDuration, formatNumber, formatTime, h, palette, withAlpha } from './dom';
import { fieldOptions } from './filters';
import type { Plots } from './plots';
import type { AppState, Area } from './state';
import { button, emptyState, icon, toggle } from './ui';

const SVG_NS = 'http://www.w3.org/2000/svg';
const CHART_H = 360;
const M = { l: 70, r: 18, t: 14, b: 46 };
const BAR_ROW = 24;
const BAR_LIMIT = 60;

type RunLevelKind = 'scatter' | 'box' | 'bar';
type SectionId = 'line' | RunLevelKind;

function s<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, ...children: (Node | string)[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  el.append(...children);
  return el;
}

/** Tick label formatter appropriate for a field (timestamps, durations, plain numbers). */
function formatterFor(field: string): (v: number) => string {
  const { kind, key } = parseColumnId(field);
  if (kind === 'fixed' && (key === 'started' || key === 'ended' || key === 'heartbeat')) return (v) => formatTime(v);
  if (kind === 'fixed' && key === 'duration') return (v) => formatDuration(v);
  return formatNumber;
}

interface Scale {
  map: (v: number) => number;
  ticks: number[];
  valid: (v: number) => boolean;
}

function makeScale(values: number[], lo: number, hi: number, log: boolean, includeZero = false): Scale {
  if (log) {
    const pos = values.filter((v) => v > 0);
    let min = pos.length ? Math.min(...pos) : 1;
    let max = pos.length ? Math.max(...pos) : 10;
    if (min === max) {
      min /= 2;
      max *= 2;
    }
    const a = Math.log10(min) - 0.05 * (Math.log10(max) - Math.log10(min));
    const b = Math.log10(max) + 0.05 * (Math.log10(max) - Math.log10(min));
    return { map: (v) => lo + ((Math.log10(v) - a) / (b - a)) * (hi - lo), ticks: logTicks(10 ** a, 10 ** b), valid: (v) => v > 0 };
  }
  let min = values.length ? Math.min(...values) : 0;
  let max = values.length ? Math.max(...values) : 1;
  if (includeZero) {
    min = Math.min(0, min);
    max = Math.max(0, max);
  }
  if (min === max) {
    const d = Math.abs(min) * 0.1 || 1;
    min -= d;
    max += d;
  }
  const pad = (max - min) * 0.05;
  const a = includeZero && min === 0 ? 0 : min - pad;
  const b = includeZero && max === 0 ? 0 : max + pad;
  return { map: (v) => lo + ((v - a) / (b - a)) * (hi - lo), ticks: niceTicks(a, b, 6).filter((t) => t >= a && t <= b), valid: () => true };
}

/** Deterministic jitter in [-0.5, 0.5) from a string, so points don't move between refreshes. */
function jitter(key: string): number {
  let hsh = 2166136261;
  for (let i = 0; i < key.length; i++) hsh = Math.imul(hsh ^ key.charCodeAt(i), 16777619);
  return ((hsh >>> 0) % 1000) / 1000 - 0.5;
}

const SECTIONS: { id: SectionId; title: string; icon: string; hint: string }[] = [
  { id: 'line', title: 'Line', icon: 'chart', hint: 'metric history of the selected runs' },
  { id: 'scatter', title: 'Scatter', icon: 'scatter', hint: 'two run-level fields of the filtered runs' },
  { id: 'box', title: 'Box', icon: 'box', hint: 'distribution per group of the filtered runs' },
  { id: 'bar', title: 'Bar', icon: 'columns', hint: 'one value per run or per group of the filtered runs' },
];

/** One run-level chart section (scatter / box / bar): controls, info line, SVG chart, legend. */
class RunLevelChart {
  readonly body: HTMLElement;
  readonly controls = h('div', { class: 'plot-options' });
  readonly info = h('div', { class: 'analysis-info' });
  readonly chartBox = h('div', { class: 'svg-chart' });
  readonly legend = h('div', { class: 'plot-legend' });
  readonly tooltip = h('div', { class: 'chart-tooltip', role: 'tooltip' });
  renderedKey = '';
  controlsKey = '';
  width = 0;

  constructor(readonly kind: RunLevelKind, onResize: () => void) {
    this.tooltip.hidden = true;
    this.chartBox.append(this.tooltip);
    this.body = h('div', { class: 'run-level' }, this.controls, this.info, this.chartBox, this.legend);
    new ResizeObserver(() => {
      const w = this.chartBox.clientWidth;
      if (w && Math.abs(w - this.width) > 2) {
        this.width = w;
        this.renderedKey = '';
        onResize();
      }
    }).observe(this.chartBox);
  }
}

export class Analysis {
  readonly el: HTMLElement;
  private readonly sectionEls = new Map<SectionId, { details: HTMLDetailsElement; scope: HTMLElement }>();
  private readonly charts: Record<RunLevelKind, RunLevelChart>;

  constructor(
    private readonly st: AppState,
    private readonly plots: Plots,
    private readonly onPick: (key: string) => void,
  ) {
    this.charts = {
      scatter: new RunLevelChart('scatter', () => this.renderChart('scatter')),
      box: new RunLevelChart('box', () => this.renderChart('box')),
      bar: new RunLevelChart('bar', () => this.renderChart('bar')),
    };
    const collapsed = new Set(st.s.analysis.collapsed);
    const sections = SECTIONS.map((sec) => {
      const scope = h('span', { class: 'viz-scope' });
      const details = h(
        'details',
        { class: 'viz-section', open: !collapsed.has(sec.id) },
        h('summary', {}, icon('chevronRight', 14), icon(sec.icon, 15), h('h2', {}, sec.title), h('span', { class: 'viz-hint' }, sec.hint), h('span', { class: 'spacer' }), scope),
        sec.id === 'line' ? plots.el : this.charts[sec.id].body,
      ) as HTMLDetailsElement;
      details.addEventListener('toggle', () => {
        const set = new Set(this.st.s.analysis.collapsed);
        if (details.open) set.delete(sec.id);
        else set.add(sec.id);
        this.st.s.analysis.collapsed = [...set];
        if (details.open && sec.id !== 'line') this.charts[sec.id].renderedKey = '';
        this.st.changed('plots');
      });
      this.sectionEls.set(sec.id, { details, scope });
      return details;
    });
    this.el = h('section', { class: 'viz-stack', 'aria-label': 'Visualizations' }, ...sections);
  }

  private isOpen(id: SectionId): boolean {
    return this.sectionEls.get(id)!.details.open;
  }

  render(areas: Set<Area>): void {
    const sel = this.st.plottedRuns().length;
    const filtered = this.st.filteredRuns().length;
    for (const [id, { scope }] of this.sectionEls) {
      scope.textContent = id === 'line' ? `${sel} selected run${sel === 1 ? '' : 's'}` : `${filtered} filtered run${filtered === 1 ? '' : 's'}`;
    }
    if (this.isOpen('line')) this.plots.render(areas);
    const relevant = ['runs', 'table', 'plots', 'selection', 'toolbar', 'nav', 'detail'].some((a) => areas.has(a as Area));
    if (!relevant) return;
    for (const kind of ['scatter', 'box', 'bar'] as const) if (this.isOpen(kind)) this.renderChart(kind);
  }

  // -- field defaults ----------------------------------------------------------------

  private pickNumeric(current: string | null, prefs: string[], kinds: string[]): string | null {
    const fields = this.st.numericFields();
    const ids = new Set(fields.map((f) => f.id));
    if (current && ids.has(current)) return current;
    for (const p of prefs) if (ids.has(p)) return p;
    for (const k of kinds) {
      const f = fields.find((x) => x.kind === k);
      if (f) return f.id;
    }
    return fields[0]?.id ?? null;
  }

  private resolved() {
    const a = this.st.s.analysis;
    const metricPrefs = ['best:val/auc', 'summary:test/auc'];
    const metricKinds = ['best', 'summary', 'last'];
    const auto = (v: string | null, fallback: string | null) => (v === 'auto' ? fallback : v);
    return {
      x: this.pickNumeric(a.x, ['param:optim.lr'], ['param', 'fixed']),
      y: this.pickNumeric(a.y, metricPrefs, metricKinds),
      size: a.size && this.st.numericFields().some((f) => f.id === a.size) ? a.size : null,
      color: auto(a.color, this.st.s.groupBy),
      boxField: this.pickNumeric(a.boxField, metricPrefs, metricKinds),
      boxGroup: auto(a.boxGroup, this.st.s.groupBy ?? 'group'),
      barField: this.pickNumeric(a.bar.field, metricPrefs, metricKinds),
      barGroup: auto(a.bar.group, this.st.s.groupBy),
    };
  }

  // -- controls ------------------------------------------------------------------------

  private renderControls(c: RunLevelChart, r: ReturnType<Analysis['resolved']>): void {
    const a = this.st.s.analysis;
    const numeric = this.st.numericFields();
    const groups = this.st.groupFields();
    const key = JSON.stringify([a, r, numeric.map((f) => f.id), groups.map((f) => f.id), this.st.s.groupBy]);
    if (key === c.controlsKey) return;
    c.controlsKey = key;

    const select = (label: string, options: HTMLElement[], value: string, onChange: (v: string) => void, title = '') => {
      const sel = h('select', { 'aria-label': label });
      sel.append(...options);
      sel.value = value;
      sel.addEventListener('change', () => onChange(sel.value));
      return h('label', { class: 'field', title }, h('span', { class: 'field-label' }, label), sel);
    };
    const set = (patch: Partial<AppState['s']['analysis']>) => {
      Object.assign(this.st.s.analysis, patch);
      this.st.changed('plots');
    };
    const setBar = (patch: Partial<AppState['s']['analysis']['bar']>) => set({ bar: { ...a.bar, ...patch } });
    const autoLabel = `auto (${this.st.s.groupBy ? this.st.fieldLabel(this.st.s.groupBy) : 'table grouping: none'})`;
    const groupOpts = (current: string | null) => [h('option', { value: 'auto' }, autoLabel), ...fieldOptions(groups, current, 'none')];
    const opt = (value: string, label: string) => h('option', { value }, label);

    if (c.kind === 'scatter') {
      c.controls.replaceChildren(
        select('X', fieldOptions(numeric, r.x), r.x ?? '', (v) => set({ x: v })),
        button({ icon: 'refresh', title: 'Swap X and Y', variant: 'ghost', onClick: () => set({ x: r.y, y: r.x }) }),
        select('Y', fieldOptions(numeric, r.y), r.y ?? '', (v) => set({ y: v })),
        select('Size', fieldOptions(numeric, r.size, 'none'), r.size ?? '', (v) => set({ size: v || null })),
        select('Color', groupOpts(a.color), a.color ?? '', (v) => set({ color: v || null }), 'Colour points by a categorical field'),
        toggle('Log X', a.logX, (v) => set({ logX: v })),
        toggle('Log Y', a.logY, (v) => set({ logY: v })),
      );
    } else if (c.kind === 'box') {
      c.controls.replaceChildren(
        select('Value', fieldOptions(numeric, r.boxField), r.boxField ?? '', (v) => set({ boxField: v })),
        select('Group', groupOpts(a.boxGroup), a.boxGroup ?? '', (v) => set({ boxGroup: v || null }), 'One box per value of this field'),
        toggle('Log Y', a.boxLogY, (v) => set({ boxLogY: v })),
      );
    } else {
      const modeSel = select('Bars', [opt('runs', 'one per run'), opt('groups', 'group mean (min–max)')], a.bar.mode, (v) => setBar({ mode: v as 'runs' | 'groups' }));
      c.controls.replaceChildren(
        select('Value', fieldOptions(numeric, r.barField), r.barField ?? '', (v) => setBar({ field: v })),
        modeSel,
        select('Group', groupOpts(a.bar.group), a.bar.group ?? '', (v) => setBar({ group: v || null }), 'Colour (per run) or aggregate (group mean) by this field'),
        select('Sort', [opt('desc', 'highest first'), opt('asc', 'lowest first'), opt('table', 'table order')], a.bar.sort, (v) => setBar({ sort: v as 'desc' | 'asc' | 'table' })),
        toggle('Start at zero', a.bar.zero, (v) => setBar({ zero: v }), 'Bars start at 0 (off: the axis fits the data range)'),
      );
    }
  }

  // -- rendering -----------------------------------------------------------------------

  private renderChart(kind: RunLevelKind): void {
    const c = this.charts[kind];
    const r = this.resolved();
    this.renderControls(c, r);
    const runs = this.st.filteredRuns();
    const width = Math.max(320, c.chartBox.clientWidth || 600);
    const common = [kind, r, this.st.s.analysis, width, this.st.s.selected, this.st.s.focused];

    if (kind === 'scatter') {
      if (!r.x || !r.y) return this.showEmpty(c, 'No numeric run-level fields found (params or metrics.json).');
      const data = scatterData(runs, r.x, r.y, { sizeField: r.size, groupField: r.color });
      const key = JSON.stringify([...common, data]);
      if (key === c.renderedKey) return;
      c.renderedKey = key;
      this.drawScatter(c, data, r.x, r.y, r.size, r.color, width, runs.length);
    } else if (kind === 'box') {
      if (!r.boxField) return this.showEmpty(c, 'No numeric run-level fields found (params or metrics.json).');
      const data = boxData(runs, r.boxField, r.boxGroup);
      const key = JSON.stringify([...common, data]);
      if (key === c.renderedKey) return;
      c.renderedKey = key;
      this.drawBox(c, data, r.boxField, r.boxGroup, width, runs.length);
    } else {
      if (!r.barField) return this.showEmpty(c, 'No numeric run-level fields found (params or metrics.json).');
      const b = this.st.s.analysis.bar;
      const mode = b.mode === 'groups' && !r.barGroup ? 'runs' : b.mode;
      const data = barData(runs, r.barField, { mode, groupField: r.barGroup, sort: b.sort, limit: BAR_LIMIT });
      const key = JSON.stringify([...common, data, this.st.s.colors]);
      if (key === c.renderedKey) return;
      c.renderedKey = key;
      this.drawBar(c, data, r.barField, r.barGroup, mode, b.mode === 'groups' && !r.barGroup, width, runs.length);
    }
  }

  private showEmpty(c: RunLevelChart, msg: string): void {
    c.renderedKey = '';
    c.info.textContent = '';
    c.chartBox.querySelector('svg')?.remove();
    c.chartBox.querySelector('.empty-state')?.remove();
    c.chartBox.prepend(emptyState({ icon: 'scatter', title: 'Nothing to plot', text: msg }));
    c.legend.replaceChildren();
  }

  private axes(svg: SVGSVGElement, xs: Scale | null, ys: Scale | null, xFmt: (v: number) => string, yFmt: (v: number) => string, w: number, height: number, m: typeof M, xTitle: string, yTitle: string): void {
    const fg = cssVar('--tm-chart-axis', '#7d8593');
    const grid = cssVar('--tm-chart-grid', 'rgba(255,255,255,0.06)');
    const g = s('g', { class: 'axes', 'font-size': 11, fill: fg });
    if (ys) {
      for (const t of ys.ticks) {
        const y = ys.map(t);
        g.append(s('line', { x1: m.l, x2: w - m.r, y1: y, y2: y, stroke: grid }), s('text', { x: m.l - 6, y: y + 4, 'text-anchor': 'end' }, yFmt(t)));
      }
    }
    if (xs) {
      for (const t of xs.ticks) {
        const x = xs.map(t);
        g.append(s('line', { x1: x, x2: x, y1: m.t, y2: height - m.b, stroke: grid }), s('text', { x, y: height - m.b + 16, 'text-anchor': 'middle' }, xFmt(t)));
      }
    }
    if (xTitle) g.append(s('text', { x: (m.l + w - m.r) / 2, y: height - 6, 'text-anchor': 'middle', 'font-weight': 600 }, xTitle));
    if (yTitle) g.append(s('text', { x: 14, y: (m.t + height - m.b) / 2, 'text-anchor': 'middle', 'font-weight': 600, transform: `rotate(-90 14 ${(m.t + height - m.b) / 2})` }, yTitle));
    svg.append(g);
  }

  private mountSvg(c: RunLevelChart, svg: SVGSVGElement, rows: Map<string, string[]>, clickable: (key: string) => boolean = () => true): void {
    c.chartBox.querySelector('svg')?.remove();
    c.chartBox.querySelector('.empty-state')?.remove();
    c.chartBox.prepend(svg);
    const hide = () => (c.tooltip.hidden = true);
    svg.addEventListener('mouseleave', hide);
    svg.addEventListener('mousemove', (e) => {
      const key = (e.target as Element).getAttribute?.('data-key');
      const lines = key ? rows.get(key) : undefined;
      if (!key || !lines) return hide();
      c.tooltip.replaceChildren(...lines.map((l, i) => h('div', { class: i === 0 ? 'tt-x' : 'tt-row' }, l)));
      c.tooltip.hidden = false;
      const box = c.chartBox.getBoundingClientRect();
      const x = e.clientX - box.left + c.chartBox.scrollLeft;
      const y = e.clientY - box.top + c.chartBox.scrollTop;
      const w = c.tooltip.offsetWidth;
      c.tooltip.style.left = `${x + 14 + w > box.width + c.chartBox.scrollLeft ? x - w - 14 : x + 14}px`;
      c.tooltip.style.top = `${Math.max(0, y - 10)}px`;
    });
    svg.addEventListener('click', (e) => {
      const key = (e.target as Element).getAttribute?.('data-key');
      if (key && clickable(key)) this.onPick(key);
    });
  }

  private renderGroupLegend(c: RunLevelChart, labels: string[], colorOf: Map<string, number>, field: string | null): void {
    const colors = palette();
    if (!field || labels.length === 0) {
      c.legend.replaceChildren();
      return;
    }
    c.legend.replaceChildren(
      h('span', { class: 'muted' }, `${this.st.fieldLabel(field)}:`),
      ...labels.map((l) => h('span', { class: 'legend-item static' }, h('span', { class: 'swatch', style: `background:${colors[colorOf.get(l) ?? 0]}` }), l)),
    );
  }

  private drawScatter(c: RunLevelChart, data: ScatterData, xf: string, yf: string, sizeF: string | null, colorF: string | null, w: number, total: number): void {
    const { logX, logY } = this.st.s.analysis;
    const colors = palette();
    const colorOf = colorF ? this.st.groupColorIndex(colorF) : new Map<string, number>();
    const xs = makeScale(data.points.map((p) => p.x), M.l, w - M.r, logX);
    const ys = makeScale(data.points.map((p) => p.y), CHART_H - M.b, M.t, logY);
    const pts = data.points.filter((p) => xs.valid(p.x) && ys.valid(p.y));
    const logDropped = data.points.length - pts.length;
    const sizes = pts.map((p) => p.size).filter((v): v is number => v !== null);
    const sMin = Math.min(...sizes);
    const sMax = Math.max(...sizes);
    const radius = (v: number | null) => (v === null || !sizes.length ? 4.5 : sMax === sMin ? 7 : 3 + 9 * Math.sqrt((v - sMin) / (sMax - sMin)));

    const svg = s('svg', { width: w, height: CHART_H, class: 'scatter', role: 'img', 'aria-label': `Scatter of ${this.st.fieldLabel(yf)} vs ${this.st.fieldLabel(xf)}` });
    this.axes(svg, xs, ys, formatterFor(xf), formatterFor(yf), w, CHART_H, M, this.st.fieldLabel(xf), this.st.fieldLabel(yf));
    const sel = new Set(this.st.s.selected);
    const fg = cssVar('--tm-text', '#e4e7ec');
    const rows = new Map<string, string[]>();
    const xFmt = formatterFor(xf);
    const yFmt = formatterFor(yf);
    // Larger points first so small ones stay clickable on top.
    for (const p of [...pts].sort((a, b) => radius(b.size) - radius(a.size))) {
      const color = colors[p.group !== null ? (colorOf.get(p.group) ?? 0) : 0]!;
      const focused = p.key === this.st.s.focused;
      const selected = sel.has(p.key);
      svg.append(
        s('circle', {
          cx: xs.map(p.x),
          cy: ys.map(p.y),
          r: radius(p.size) + (focused ? 2 : 0),
          fill: withAlpha(color, 0.7),
          stroke: focused || selected ? fg : color,
          'stroke-width': focused ? 2.5 : selected ? 1.5 : 1,
          'data-key': p.key,
          class: 'pt',
        }),
      );
      const lines = [p.name, `${this.st.fieldLabel(xf)}: ${xFmt(p.x)}`, `${this.st.fieldLabel(yf)}: ${yFmt(p.y)}`];
      if (sizeF) lines.push(`${this.st.fieldLabel(sizeF)}: ${p.size === null ? '—' : formatNumber(p.size)}`);
      if (colorF) lines.push(`${this.st.fieldLabel(colorF)}: ${p.group}`);
      rows.set(p.key, lines);
    }
    this.mountSvg(c, svg, rows);
    const excluded = data.excluded + logDropped;
    c.info.textContent = `${pts.length} of ${total} filtered runs plotted${excluded ? ` · ${excluded} excluded (missing, non-numeric${logDropped ? ' or ≤ 0 on a log axis' : ''})` : ''} · click a point to open the run`;
    this.renderGroupLegend(c, colorF ? data.groups : [], colorOf, colorF);
  }

  private drawBox(c: RunLevelChart, data: BoxData, field: string, groupF: string | null, minW: number, total: number): void {
    const logY = this.st.s.analysis.boxLogY;
    const colors = palette();
    const colorOf = groupF ? this.st.groupColorIndex(groupF) : new Map<string, number>();
    const bandW = Math.max(56, Math.min(160, (minW - M.l - M.r) / Math.max(1, data.boxes.length)));
    const w = Math.max(minW, M.l + M.r + bandW * data.boxes.length);
    const all = data.boxes.flatMap((b) => b.values.map((v) => v.value));
    const ys = makeScale(all, CHART_H - M.b, M.t, logY);
    const fmt = formatterFor(field);
    const svg = s('svg', { width: w, height: CHART_H, class: 'boxplot', role: 'img', 'aria-label': `Box plot of ${this.st.fieldLabel(field)}` });
    this.axes(svg, null, ys, fmt, fmt, w, CHART_H, M, groupF ? this.st.fieldLabel(groupF) : '', this.st.fieldLabel(field));
    const fg = cssVar('--tm-text', '#e4e7ec');
    const muted = cssVar('--tm-text-muted', '#747c8a');
    const sel = new Set(this.st.s.selected);
    const rows = new Map<string, string[]>();
    let logDropped = 0;
    const clampY = (v: number) => (ys.valid(v) ? ys.map(v) : CHART_H - M.b);

    data.boxes.forEach((b, i) => {
      const cx = M.l + bandW * (i + 0.5);
      const bw = Math.min(46, bandW * 0.5);
      const color = colors[b.label === 'all runs' ? 0 : (colorOf.get(b.label) ?? 0)]!;
      const g = s('g', {});
      g.append(
        s('title', {}, `${b.label} (n=${b.n})\nmedian ${fmt(b.median)}\nIQR ${fmt(b.q1)} – ${fmt(b.q3)}\nrange ${fmt(b.min)} – ${fmt(b.max)}`),
        s('line', { x1: cx, x2: cx, y1: clampY(b.lo), y2: clampY(b.q1), stroke: color }),
        s('line', { x1: cx, x2: cx, y1: clampY(b.q3), y2: clampY(b.hi), stroke: color }),
        s('line', { x1: cx - bw / 4, x2: cx + bw / 4, y1: clampY(b.lo), y2: clampY(b.lo), stroke: color }),
        s('line', { x1: cx - bw / 4, x2: cx + bw / 4, y1: clampY(b.hi), y2: clampY(b.hi), stroke: color }),
        s('rect', { x: cx - bw / 2, y: clampY(b.q3), width: bw, height: Math.max(1, clampY(b.q1) - clampY(b.q3)), fill: withAlpha(color, 0.18), stroke: color }),
        s('line', { x1: cx - bw / 2, x2: cx + bw / 2, y1: clampY(b.median), y2: clampY(b.median), stroke: color, 'stroke-width': 2.5 }),
      );
      const label = b.label.length > 18 ? b.label.slice(0, 17) + '…' : b.label;
      g.append(
        s('text', { x: cx, y: CHART_H - M.b + 16, 'text-anchor': 'middle', 'font-size': 11, fill: fg }, s('title', {}, b.label), label),
        s('text', { x: cx, y: CHART_H - M.b + 29, 'text-anchor': 'middle', 'font-size': 10, fill: muted }, `n=${b.n}`),
      );
      // Individual runs (jittered) so the underlying runs can be inspected and clicked.
      const outliers = new Set(b.outliers.map((o) => o.key));
      for (const v of b.values) {
        if (!ys.valid(v.value)) {
          logDropped++;
          continue;
        }
        const focused = v.key === this.st.s.focused;
        g.append(
          s('circle', {
            cx: cx + jitter(v.key) * bw * 0.9,
            cy: ys.map(v.value),
            r: focused ? 5 : outliers.has(v.key) ? 3.5 : 2.6,
            fill: outliers.has(v.key) ? 'none' : withAlpha(color, 0.75),
            stroke: focused || sel.has(v.key) ? fg : color,
            'stroke-width': focused ? 2 : 1,
            'data-key': v.key,
            class: 'pt',
          }),
        );
        rows.set(v.key, [v.name, `${this.st.fieldLabel(field)}: ${fmt(v.value)}`, groupF ? `${this.st.fieldLabel(groupF)}: ${b.label}` : '', outliers.has(v.key) ? 'outlier (> 1.5 IQR)' : ''].filter(Boolean));
      }
      svg.append(g);
    });
    this.mountSvg(c, svg, rows);
    const excluded = data.excluded + logDropped;
    const noneNote = data.boxes.some((b) => b.label === NONE_GROUP) ? ` · "${NONE_GROUP}" = runs without a value for the group field` : '';
    c.info.textContent = `${data.boxes.length} group${data.boxes.length === 1 ? '' : 's'} · ${total - excluded} of ${total} filtered runs${excluded ? ` · ${excluded} excluded (missing or non-numeric)` : ''}${noneNote} · click a point to open the run`;
    c.legend.replaceChildren();
  }

  /** Horizontal bars (names stay readable): one per run, or one per group with a min–max range. */
  private drawBar(c: RunLevelChart, data: BarData, field: string, groupF: string | null, mode: 'runs' | 'groups', groupsNeedGroup: boolean, w: number, total: number): void {
    if (!data.bars.length) return this.showEmpty(c, `No filtered run has a numeric value for ${this.st.fieldLabel(field)}.`);
    const colors = palette();
    const colorOf = groupF ? this.st.groupColorIndex(groupF) : new Map<string, number>();
    const fmt = formatterFor(field);
    const labelW = Math.min(240, Math.max(90, Math.max(...data.bars.map((b) => b.label.length)) * 7 + 16));
    const m = { l: labelW, r: 64, t: 8, b: 40 };
    const height = m.t + m.b + data.bars.length * BAR_ROW;
    const values = data.bars.flatMap((b) => (b.min !== undefined ? [b.value, b.min, b.max!] : [b.value]));
    const zero = this.st.s.analysis.bar.zero;
    const xs = makeScale(values, m.l, w - m.r, false, zero);
    const base = xs.map(zero ? 0 : Math.min(...values));
    const svg = s('svg', { width: w, height, class: 'barplot', role: 'img', 'aria-label': `Bar chart of ${this.st.fieldLabel(field)}` });
    this.axes(svg, xs, null, fmt, fmt, w, height, m, this.st.fieldLabel(field), '');
    const fg = cssVar('--tm-text', '#e4e7ec');
    const secondary = cssVar('--tm-text-secondary', '#aab1bd');
    const sel = new Set(this.st.s.selected);
    const rows = new Map<string, string[]>();

    data.bars.forEach((b, i) => {
      const y = m.t + i * BAR_ROW;
      const color =
        mode === 'groups'
          ? colors[colorOf.get(b.label) ?? 0]!
          : b.group !== null
            ? colors[colorOf.get(b.group) ?? 0]!
            : sel.has(b.key)
              ? colors[this.st.colorIndex(b.key)]!
              : colors[0]!;
      const x = xs.map(b.value);
      const focused = mode === 'runs' && b.key === this.st.s.focused;
      const label = b.label.length > labelW / 7 ? b.label.slice(0, Math.floor(labelW / 7) - 1) + '…' : b.label;
      svg.append(
        s('text', { x: m.l - 8, y: y + BAR_ROW / 2 + 4, 'text-anchor': 'end', 'font-size': 11, fill: focused ? fg : secondary, 'font-weight': focused ? 700 : 400 }, s('title', {}, b.label), label),
        s('rect', {
          x: Math.min(base, x),
          y: y + 4,
          width: Math.max(1, Math.abs(x - base)),
          height: BAR_ROW - 8,
          rx: 2,
          fill: withAlpha(color, focused ? 0.95 : 0.7),
          stroke: focused || sel.has(b.key) ? fg : 'none',
          'stroke-width': focused ? 1.5 : 1,
          'data-key': b.key,
          class: mode === 'runs' ? 'pt' : '',
        }),
        s('text', { x: Math.max(x, base) + 6, y: y + BAR_ROW / 2 + 4, 'font-size': 11, fill: secondary }, fmt(b.value)),
      );
      if (b.min !== undefined && b.max !== undefined && b.n! > 1) {
        const cy = y + BAR_ROW / 2;
        svg.append(
          s('line', { x1: xs.map(b.min), x2: xs.map(b.max), y1: cy, y2: cy, stroke: fg, 'stroke-width': 1.2, opacity: 0.7 }),
          s('line', { x1: xs.map(b.min), x2: xs.map(b.min), y1: cy - 4, y2: cy + 4, stroke: fg, 'stroke-width': 1.2, opacity: 0.7 }),
          s('line', { x1: xs.map(b.max), x2: xs.map(b.max), y1: cy - 4, y2: cy + 4, stroke: fg, 'stroke-width': 1.2, opacity: 0.7 }),
        );
      }
      rows.set(
        b.key,
        mode === 'groups'
          ? [`${b.label} (n=${b.n})`, `mean ${fmt(b.value)}`, `min ${fmt(b.min!)} · max ${fmt(b.max!)}`]
          : [b.label, `${this.st.fieldLabel(field)}: ${fmt(b.value)}`, groupF ? `${this.st.fieldLabel(groupF)}: ${b.group}` : ''].filter(Boolean),
      );
    });
    this.mountSvg(c, svg, rows, () => mode === 'runs');
    const parts = [
      mode === 'groups' ? `${data.bars.length} groups (mean, whiskers = min–max)` : `${data.bars.length} of ${total} filtered runs`,
      data.truncated ? `${data.truncated} more not shown (max ${BAR_LIMIT}; filter to narrow down)` : '',
      data.excluded ? `${data.excluded} excluded (missing or non-numeric)` : '',
      groupsNeedGroup ? 'choose a Group field for group means' : '',
      mode === 'runs' ? 'click a bar to open the run' : '',
    ];
    c.info.textContent = parts.filter(Boolean).join(' · ');
    if (mode === 'runs' && groupF) this.renderGroupLegend(c, [...new Set(data.bars.map((b) => b.group!))], colorOf, groupF);
    else c.legend.replaceChildren();
  }
}
