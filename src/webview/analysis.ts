// Visualization switcher (Line | Scatter | Box) and the run-level scatter / box views.
// Scatter and box plots use only run-level data already in the webview (params + metrics.json
// summaries of the filtered runs); they never request metrics.jsonl histories.
import { boxData, logTicks, niceTicks, NONE_GROUP, scatterData, type BoxData, type ScatterData } from '../model/analysis';
import { parseColumnId } from '../model/run';
import { cssVar, formatDuration, formatNumber, formatTime, h, palette, withAlpha } from './dom';
import { button, emptyState, icon, toggle } from './ui';
import { fieldOptions } from './filters';
import type { Plots } from './plots';
import type { AnalysisView, AppState, Area } from './state';

const SVG_NS = 'http://www.w3.org/2000/svg';
const CHART_H = 380;
const M = { l: 70, r: 18, t: 14, b: 46 };

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

function makeScale(values: number[], lo: number, hi: number, log: boolean): Scale {
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
  if (min === max) {
    const d = Math.abs(min) * 0.1 || 1;
    min -= d;
    max += d;
  }
  const pad = (max - min) * 0.05;
  const a = min - pad;
  const b = max + pad;
  return { map: (v) => lo + ((v - a) / (b - a)) * (hi - lo), ticks: niceTicks(a, b, 6).filter((t) => t >= a && t <= b), valid: () => true };
}

/** Deterministic jitter in [-0.5, 0.5) from a string, so points don't move between refreshes. */
function jitter(key: string): number {
  let hsh = 2166136261;
  for (let i = 0; i < key.length; i++) hsh = Math.imul(hsh ^ key.charCodeAt(i), 16777619);
  return ((hsh >>> 0) % 1000) / 1000 - 0.5;
}

export class Analysis {
  readonly el: HTMLElement;
  private readonly switcher = h('div', { class: 'segmented', role: 'tablist', 'aria-label': 'Visualization type' });
  private readonly scope = h('span', { class: 'viz-scope muted' });
  private readonly runLevel = h('div', { class: 'run-level' });
  private readonly controls = h('div', { class: 'plot-options' });
  private readonly info = h('div', { class: 'muted analysis-info' });
  private readonly chartBox = h('div', { class: 'svg-chart' });
  private readonly legend = h('div', { class: 'plot-legend' });
  private readonly tooltip = h('div', { class: 'chart-tooltip' });
  private renderedKey = '';
  private controlsKey = '';
  private width = 0;

  constructor(
    private readonly st: AppState,
    private readonly plots: Plots,
    private readonly onPick: (key: string) => void,
  ) {
    this.tooltip.hidden = true;
    this.chartBox.append(this.tooltip);
    this.runLevel.append(this.controls, this.info, this.chartBox, this.legend);
    this.el = h(
      'section',
      { class: 'viz-card', 'aria-label': 'Visualization' },
      h('div', { class: 'viz-head' }, h('h2', {}, 'Visualization'), this.switcher, h('div', { class: 'spacer' }), this.scope),
      plots.el,
      this.runLevel,
    );
    new ResizeObserver(() => {
      const w = this.chartBox.clientWidth;
      if (w && Math.abs(w - this.width) > 2) {
        this.width = w;
        this.renderedKey = '';
        this.renderRunLevel();
      }
    }).observe(this.chartBox);
  }

  render(areas: Set<Area>): void {
    this.renderSwitcher();
    const view = this.st.s.analysis.view;
    this.plots.el.hidden = view !== 'line';
    this.runLevel.hidden = view === 'line';
    if (view === 'line') {
      this.plots.render(areas);
      return;
    }
    if (areas.has('runs') || areas.has('table') || areas.has('plots') || areas.has('selection') || areas.has('toolbar') || areas.has('nav') || areas.has('detail')) this.renderRunLevel();
  }

  private renderSwitcher(): void {
    const view = this.st.s.analysis.view;
    const views: [AnalysisView, string, string, string][] = [
      ['line', 'Line', 'chart', 'Metric history (metrics.jsonl) of the selected runs'],
      ['scatter', 'Scatter', 'scatter', 'Two run-level fields of all filtered runs'],
      ['box', 'Box', 'box', 'Distribution of a run-level field across groups of filtered runs'],
    ];
    const sel = this.st.plottedRuns().length;
    this.scope.textContent = view === 'line' ? `${sel} selected run${sel === 1 ? '' : 's'}` : `${this.st.filteredRuns().length} filtered runs`;
    if (this.switcher.dataset.view === view) return;
    this.switcher.dataset.view = view;
    this.switcher.replaceChildren(
      ...views.map(([id, label, ic, title]) => {
        const b = h('button', { type: 'button', class: `seg${id === view ? ' active' : ''}`, role: 'tab', 'aria-selected': id === view ? 'true' : 'false', title }, icon(ic, 14), label);
        b.addEventListener('click', () => {
          this.st.s.analysis.view = id;
          this.renderedKey = '';
          this.controlsKey = '';
          this.st.changed('plots');
        });
        return b;
      }),
    );
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
    const x = this.pickNumeric(a.x, ['param:optim.lr'], ['param', 'fixed']);
    const y = this.pickNumeric(a.y, ['best:val/auc', 'summary:test/auc'], ['best', 'summary', 'last']);
    const boxField = this.pickNumeric(a.boxField, ['best:val/auc', 'summary:test/auc'], ['best', 'summary', 'last']);
    const size = a.size && this.st.numericFields().some((f) => f.id === a.size) ? a.size : null;
    const color = a.color === 'auto' ? this.st.s.groupBy : a.color;
    const boxGroup = a.boxGroup === 'auto' ? (this.st.s.groupBy ?? 'group') : a.boxGroup;
    return { x, y, size, color, boxField, boxGroup, logX: a.logX, logY: a.logY };
  }

  // -- controls ------------------------------------------------------------------------

  private renderControls(r: ReturnType<Analysis['resolved']>): void {
    const a = this.st.s.analysis;
    const numeric = this.st.numericFields();
    const groups = this.st.groupFields();
    const key = JSON.stringify([a, r, numeric.map((f) => f.id), groups.map((f) => f.id), this.st.s.groupBy]);
    if (key === this.controlsKey) return;
    this.controlsKey = key;

    const select = (label: string, options: HTMLElement[], value: string, onChange: (v: string) => void, title = '') => {
      const sel = h('select', { 'aria-label': label });
      sel.append(...options);
      sel.value = value;
      sel.addEventListener('change', () => onChange(sel.value));
      return h('label', { class: 'field', title }, h('span', { class: 'field-label' }, label), sel);
    };
    const check = (label: string, value: boolean, onChange: (v: boolean) => void) => toggle(label, value, onChange);
    const set = (patch: Partial<AppState['s']['analysis']>) => {
      Object.assign(this.st.s.analysis, patch);
      this.st.changed('plots');
    };
    const autoLabel = `auto (${this.st.s.groupBy ? this.st.fieldLabel(this.st.s.groupBy) : 'table grouping: none'})`;
    const groupOpts = (current: string | null) => [h('option', { value: 'auto' }, autoLabel), ...fieldOptions(groups, current, 'none')];

    if (a.view === 'scatter') {
      this.controls.replaceChildren(
        select('X', fieldOptions(numeric, r.x), r.x ?? '', (v) => set({ x: v })),
        button({ icon: 'refresh', title: 'Swap X and Y', variant: 'ghost', onClick: () => set({ x: r.y, y: r.x }) }),
        select('Y', fieldOptions(numeric, r.y), r.y ?? '', (v) => set({ y: v })),
        select('Size', fieldOptions(numeric, r.size, 'none'), r.size ?? '', (v) => set({ size: v || null })),
        select('Color', groupOpts(a.color), a.color ?? '', (v) => set({ color: v || null }), 'Colour points by a categorical field'),
        check('Log X', a.logX, (v) => set({ logX: v })),
        check('Log Y', a.logY, (v) => set({ logY: v })),
      );
    } else {
      this.controls.replaceChildren(
        select('Value', fieldOptions(numeric, r.boxField), r.boxField ?? '', (v) => set({ boxField: v })),
        select('Group', groupOpts(a.boxGroup), a.boxGroup ?? '', (v) => set({ boxGroup: v || null }), 'One box per value of this field'),
        check('Log Y', a.logY, (v) => set({ logY: v })),
      );
    }
  }

  // -- rendering -----------------------------------------------------------------------

  private renderRunLevel(): void {
    const r = this.resolved();
    this.renderControls(r);
    const runs = this.st.filteredRuns();
    const view = this.st.s.analysis.view;
    const width = Math.max(320, this.chartBox.clientWidth || 600);

    if (view === 'scatter') {
      if (!r.x || !r.y) return this.showEmpty('No numeric run-level fields found (params or metrics.json).');
      const data = scatterData(runs, r.x, r.y, { sizeField: r.size, groupField: r.color });
      const key = JSON.stringify([view, r, width, data, this.st.s.selected, this.st.s.focused]);
      if (key === this.renderedKey) return;
      this.renderedKey = key;
      this.drawScatter(data, r.x, r.y, r.size, r.color, r.logX, r.logY, width, runs.length);
    } else {
      if (!r.boxField) return this.showEmpty('No numeric run-level fields found (params or metrics.json).');
      const data = boxData(runs, r.boxField, r.boxGroup);
      const key = JSON.stringify([view, r, width, data, this.st.s.selected, this.st.s.focused]);
      if (key === this.renderedKey) return;
      this.renderedKey = key;
      this.drawBox(data, r.boxField, r.boxGroup, r.logY, width, runs.length);
    }
  }

  private showEmpty(msg: string): void {
    this.renderedKey = '';
    this.info.textContent = '';
    this.chartBox.querySelector('svg')?.remove();
    this.chartBox.querySelector('.empty-state')?.remove();
    this.chartBox.prepend(emptyState({ icon: 'scatter', title: 'Nothing to plot', text: msg }));
    this.legend.replaceChildren();
  }

  private axes(svg: SVGSVGElement, xs: Scale | null, ys: Scale, xFmt: (v: number) => string, yFmt: (v: number) => string, w: number, xTitle: string, yTitle: string): void {
    const fg = cssVar('--tm-chart-axis', '#7d8593');
    const grid = cssVar('--tm-chart-grid', 'rgba(255,255,255,0.06)');
    const g = s('g', { class: 'axes', 'font-size': 11, fill: fg });
    for (const t of ys.ticks) {
      const y = ys.map(t);
      g.append(s('line', { x1: M.l, x2: w - M.r, y1: y, y2: y, stroke: grid }), s('text', { x: M.l - 6, y: y + 4, 'text-anchor': 'end' }, yFmt(t)));
    }
    if (xs) {
      for (const t of xs.ticks) {
        const x = xs.map(t);
        g.append(s('line', { x1: x, x2: x, y1: M.t, y2: CHART_H - M.b, stroke: grid }), s('text', { x, y: CHART_H - M.b + 16, 'text-anchor': 'middle' }, xFmt(t)));
      }
    }
    g.append(
      s('text', { x: (M.l + w - M.r) / 2, y: CHART_H - 6, 'text-anchor': 'middle', 'font-weight': 600 }, xTitle),
      s('text', { x: 14, y: (M.t + CHART_H - M.b) / 2, 'text-anchor': 'middle', 'font-weight': 600, transform: `rotate(-90 14 ${(M.t + CHART_H - M.b) / 2})` }, yTitle),
    );
    svg.append(g);
  }

  private mountSvg(svg: SVGSVGElement, rows: Map<string, string[]>): void {
    this.chartBox.querySelector('svg')?.remove();
    this.chartBox.querySelector('.empty-state')?.remove();
    this.chartBox.prepend(svg);
    const hide = () => (this.tooltip.hidden = true);
    svg.addEventListener('mouseleave', hide);
    svg.addEventListener('mousemove', (e) => {
      const key = (e.target as Element).getAttribute?.('data-key');
      const lines = key ? rows.get(key) : undefined;
      if (!key || !lines) return hide();
      this.tooltip.replaceChildren(...lines.map((l, i) => h('div', { class: i === 0 ? 'tt-x' : 'tt-row' }, l)));
      this.tooltip.hidden = false;
      const box = this.chartBox.getBoundingClientRect();
      const x = e.clientX - box.left + this.chartBox.scrollLeft;
      const y = e.clientY - box.top;
      const w = this.tooltip.offsetWidth;
      this.tooltip.style.left = `${x + 14 + w > box.width + this.chartBox.scrollLeft ? x - w - 14 : x + 14}px`;
      this.tooltip.style.top = `${Math.max(0, y - 10)}px`;
    });
    svg.addEventListener('click', (e) => {
      const key = (e.target as Element).getAttribute?.('data-key');
      if (key) this.onPick(key);
    });
  }

  private renderGroupLegend(labels: string[], colorOf: Map<string, number>, field: string | null): void {
    const colors = palette();
    if (!field || labels.length === 0) {
      this.legend.replaceChildren();
      return;
    }
    this.legend.replaceChildren(
      h('span', { class: 'muted' }, `${this.st.fieldLabel(field)}:`),
      ...labels.map((l) => h('span', { class: 'legend-item static' }, h('span', { class: 'swatch', style: `background:${colors[colorOf.get(l) ?? 0]}` }), l)),
    );
  }

  private drawScatter(data: ScatterData, xf: string, yf: string, sizeF: string | null, colorF: string | null, logX: boolean, logY: boolean, w: number, total: number): void {
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
    this.axes(svg, xs, ys, formatterFor(xf), formatterFor(yf), w, this.st.fieldLabel(xf), this.st.fieldLabel(yf));
    const sel = new Set(this.st.s.selected);
    const fg = cssVar('--tm-text', '#e4e7ec');
    const rows = new Map<string, string[]>();
    const xFmt = formatterFor(xf);
    const yFmt = formatterFor(yf);
    // Larger points first so small ones stay clickable on top.
    const ordered = [...pts].sort((a, b) => radius(b.size) - radius(a.size));
    for (const p of ordered) {
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
    this.mountSvg(svg, rows);
    const excluded = data.excluded + logDropped;
    this.info.textContent = `${pts.length} of ${total} filtered runs plotted${excluded ? ` · ${excluded} excluded (missing, non-numeric${logDropped ? ' or ≤ 0 on a log axis' : ''})` : ''} · click a point to open the run`;
    this.renderGroupLegend(colorF ? data.groups : [], colorOf, colorF);
  }

  private drawBox(data: BoxData, field: string, groupF: string | null, logY: boolean, minW: number, total: number): void {
    const colors = palette();
    const colorOf = groupF ? this.st.groupColorIndex(groupF) : new Map<string, number>();
    const bandW = Math.max(56, Math.min(160, (minW - M.l - M.r) / Math.max(1, data.boxes.length)));
    const w = Math.max(minW, M.l + M.r + bandW * data.boxes.length);
    const all = data.boxes.flatMap((b) => b.values.map((v) => v.value));
    const ys = makeScale(all, CHART_H - M.b, M.t, logY);
    const fmt = formatterFor(field);
    const svg = s('svg', { width: w, height: CHART_H, class: 'boxplot', role: 'img', 'aria-label': `Box plot of ${this.st.fieldLabel(field)}` });
    this.axes(svg, null, ys, fmt, fmt, w, groupF ? this.st.fieldLabel(groupF) : '', this.st.fieldLabel(field));
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
      const boxTitle = s('title', {}, `${b.label} (n=${b.n})\nmedian ${fmt(b.median)}\nIQR ${fmt(b.q1)} – ${fmt(b.q3)}\nrange ${fmt(b.min)} – ${fmt(b.max)}`);
      g.prepend(boxTitle);
      svg.append(g);
    });
    this.mountSvg(svg, rows);
    const excluded = data.excluded + logDropped;
    const noneNote = data.boxes.some((b) => b.label === NONE_GROUP) ? ` · "${NONE_GROUP}" = runs without a value for the group field` : '';
    this.info.textContent = `${data.boxes.length} group${data.boxes.length === 1 ? '' : 's'} · ${total - excluded} of ${total} filtered runs${excluded ? ` · ${excluded} excluded (missing or non-numeric)` : ''}${noneNote} · click a point to open the run`;
    this.legend.replaceChildren();
  }
}
