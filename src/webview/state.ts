// Webview state: data received from the host plus persisted UI state (sort, filters, selection...).
import { defaultVisibleColumns, differingParams, filterRuns, pruneSelection, type FilterState } from '../model/filters';
import { groupRuns, type RunGroup } from '../model/analysis';
import type { XMode } from '../model/metricSeries';
import { dynamicColumns, sortRuns, type ColumnDef, type SortKey, FIXED_COLUMNS, OPTIONAL_FIXED_COLUMNS, parseColumnId } from '../model/run';
import type { HostToWebview, WebviewToHost } from '../protocol';
import type { RunDetail, RunSummary, SeriesPayload, ViewConfig } from '../types';
import { nextFrame } from './dom';

export type { XMode };
export type AnalysisView = 'line' | 'scatter' | 'box';
export type AppView = 'overview' | 'runs' | 'compare';

/** One row of the (possibly grouped) run table. */
export type TableItem = { kind: 'group'; group: RunGroup; color: number; collapsed: boolean } | { kind: 'run'; run: RunSummary };

export interface PersistedState {
  version: 1;
  sort: SortKey[];
  filters: FilterState;
  selected: string[]; // selection order matters (plot/colour order)
  visibleColumns: string[] | null; // null = automatic defaults
  differingOnly: boolean;
  focused: string | null;
  /** Main navigation (sidebar). */
  view: AppView;
  sidebarCollapsed: boolean;
  /** Per-column filter inputs under the table header. */
  showFilterRow: boolean;
  compareDiffOnly: boolean;
  plot: {
    metrics: string[] | null; // null = automatic defaults
    xMode: XMode;
    logY: boolean;
    smoothing: number;
    hidden: string[];
    /** Line colours: stable per-run colour, or the colour of the run's group (when grouping). */
    colorBy: 'run' | 'group';
  };
  /** Table grouping field (column id), or null. */
  groupBy: string | null;
  collapsedGroups: string[];
  analysis: {
    view: AnalysisView;
    x: string | null;
    y: string | null;
    size: string | null;
    /** Scatter colour field; 'auto' follows the table grouping. */
    color: string | null;
    boxField: string | null;
    /** Box grouping field; 'auto' follows the table grouping. */
    boxGroup: string | null;
    logX: boolean;
    logY: boolean;
    boxLogY: boolean;
    bar: {
      field: string | null;
      /** 'auto' follows the table grouping. */
      group: string | null;
      mode: 'runs' | 'groups';
      sort: 'desc' | 'asc' | 'table';
      /** Bars start at zero (honest lengths); off = axis fits the data range. */
      zero: boolean;
    };
    /** Visualization sections the user collapsed ('line' | 'scatter' | 'box' | 'bar'). */
    collapsed: string[];
  };
  colors: Record<string, number>;
  tableHeight: number;
}

export const MAX_PLOT_RUNS = 30;
export const PALETTE_SIZE = 10;

const DEFAULT_STATE: PersistedState = {
  version: 1,
  sort: [{ col: 'started', dir: 'desc' }],
  filters: { search: '', statuses: [], columns: {} },
  selected: [],
  visibleColumns: null,
  differingOnly: false,
  focused: null,
  view: 'runs',
  sidebarCollapsed: false,
  showFilterRow: false,
  compareDiffOnly: false,
  plot: { metrics: null, xMode: 'step', logY: false, smoothing: 0, hidden: [], colorBy: 'run' },
  groupBy: null,
  collapsedGroups: [],
  analysis: {
    view: 'line',
    x: null,
    y: null,
    size: null,
    color: 'auto',
    boxField: null,
    boxGroup: 'auto',
    logX: false,
    logY: false,
    boxLogY: false,
    bar: { field: null, group: 'auto', mode: 'runs', sort: 'desc', zero: true },
    collapsed: [],
  },
  colors: {},
  tableHeight: 320,
};

interface VsCodeApi {
  postMessage(msg: WebviewToHost): void;
  getState(): unknown;
  setState(s: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

export type Area = 'runs' | 'table' | 'selection' | 'plots' | 'series' | 'detail' | 'toolbar' | 'status' | 'nav';

export class AppState {
  readonly vscode: VsCodeApi = acquireVsCodeApi();
  runs = new Map<string, RunSummary>();
  config: ViewConfig = { staleAfterSeconds: 60, refreshIntervalSeconds: 5, maxPointsPerSeries: 5000 };
  roots: string[] = [];
  refreshedAt = 0;
  loaded = false;
  detail: RunDetail | null = null;
  readonly series = new Map<string, SeriesPayload>();
  error: string | null = null;
  /** True between a manual refresh request and the next host update. */
  refreshing = false;
  s: PersistedState;

  private listeners = new Set<(areas: Set<Area>) => void>();
  private pending = new Set<Area>();
  private scheduled = false;
  private cache: { all?: RunSummary[]; filtered?: RunSummary[]; sorted?: RunSummary[]; columns?: ColumnDef[]; items?: TableItem[]; groups?: RunGroup[] } = {};

  constructor() {
    // Webview state survives hide/show; the host copy (VS Code workspace storage) survives closing
    // and reopening the panel. Older saved states may lack newer fields; defaults fill them in.
    const saved = (this.vscode.getState() ?? readHostState()) as Partial<PersistedState> | null;
    this.s =
      saved && saved.version === 1
        ? {
            ...structuredClone(DEFAULT_STATE),
            ...saved,
            plot: { ...DEFAULT_STATE.plot, ...(saved.plot ?? {}) },
            analysis: { ...DEFAULT_STATE.analysis, ...(saved.analysis ?? {}), bar: { ...DEFAULT_STATE.analysis.bar, ...(saved.analysis?.bar ?? {}) } },
          }
        : structuredClone(DEFAULT_STATE);
  }

  // -- change notification ---------------------------------------------------

  subscribe(fn: (areas: Set<Area>) => void): void {
    this.listeners.add(fn);
  }

  /** Marks areas dirty; listeners run once per animation frame with all dirty areas. */
  changed(...areas: Area[]): void {
    if (areas.some((a) => a === 'runs' || a === 'table' || a === 'selection')) this.cache = {};
    for (const a of areas) this.pending.add(a);
    if (this.scheduled) return;
    this.scheduled = true;
    nextFrame(() => {
      this.scheduled = false;
      const areas = this.pending;
      this.pending = new Set();
      this.persist();
      for (const l of this.listeners) l(areas);
    });
  }

  private hostSaveTimer: ReturnType<typeof setTimeout> | undefined;

  private persist(): void {
    this.vscode.setState(this.s);
    // Also keep a copy in the extension's workspace storage so the plots, selection and filters
    // come back after the panel is closed and reopened (debounced).
    clearTimeout(this.hostSaveTimer);
    this.hostSaveTimer = setTimeout(() => this.post({ type: 'saveState', state: this.s as unknown as Record<string, unknown> }), 800);
  }

  post(msg: WebviewToHost): void {
    this.vscode.postMessage(msg);
  }

  // -- host messages -----------------------------------------------------------

  handle(msg: HostToWebview): void {
    switch (msg.type) {
      case 'runsSnapshot':
        this.runs = new Map(msg.runs.map((r) => [r.key, r]));
        this.config = msg.config;
        this.roots = msg.roots;
        this.refreshedAt = msg.refreshedAt;
        this.loaded = msg.scanned;
        // Only prune the (restored) selection against a complete run list.
        this.afterRunsChanged(msg.scanned);
        break;
      case 'runsPatch': {
        for (const r of msg.upserts) this.runs.set(r.key, r);
        for (const k of msg.removed) this.runs.delete(k);
        if (msg.roots) this.roots = msg.roots;
        this.refreshedAt = msg.refreshedAt;
        this.refreshing = false;
        const firstScan = !this.loaded;
        this.loaded = true;
        this.afterRunsChanged(firstScan || msg.removed.length > 0, msg.upserts.map((u) => u.key));
        if (this.s.focused && msg.upserts.some((u) => u.key === this.s.focused)) this.requestDetail();
        break;
      }
      case 'series':
        for (const s of msg.series) this.series.set(seriesId(s.runKey, s.metric), s);
        this.changed('series');
        break;
      case 'runDetail':
        if (msg.detail.key === this.s.focused) {
          this.detail = msg.detail;
          this.changed('detail');
        }
        break;
      case 'error':
        this.error = msg.message;
        this.changed('status');
        break;
    }
  }

  /** `changedKeys` undefined = everything may have changed (snapshot). */
  private afterRunsChanged(removed: boolean, changedKeys?: string[]): void {
    const areas: Area[] = ['runs', 'table', 'plots', 'toolbar', 'status'];
    const watched = new Set([...this.s.selected, ...(this.s.focused ? [this.s.focused] : [])]);
    if (removed || !changedKeys || changedKeys.some((k) => watched.has(k))) areas.push('detail');
    if (removed) {
      const existing = new Set(this.runs.keys());
      const before = this.s.selected.length;
      this.s.selected = [...pruneSelection(new Set(this.s.selected), existing)];
      if (this.s.selected.length !== before) areas.push('selection');
      if (this.s.focused && !existing.has(this.s.focused)) {
        this.s.focused = null;
        this.detail = null;
      }
    }
    this.changed(...areas);
    // Default metrics depend on the known runs; re-sync the subscription if it changed.
    this.requestSeries();
  }

  // -- derived data --------------------------------------------------------------

  allRuns(): RunSummary[] {
    return (this.cache.all ??= [...this.runs.values()]);
  }

  filteredRuns(): RunSummary[] {
    return (this.cache.filtered ??= filterRuns(this.allRuns(), this.s.filters));
  }

  sortedRuns(): RunSummary[] {
    return (this.cache.sorted ??= sortRuns(this.filteredRuns(), this.s.sort));
  }

  /** Groups of the filtered runs by the table grouping field (null when not grouping). */
  tableGroups(): RunGroup[] | null {
    if (!this.s.groupBy) return null;
    return (this.cache.groups ??= groupRuns(this.sortedRuns(), this.s.groupBy));
  }

  /** Rows of the run table: group headers (when grouping) followed by their runs unless collapsed. */
  tableItems(): TableItem[] {
    if (this.cache.items) return this.cache.items;
    const groups = this.tableGroups();
    if (!groups) return (this.cache.items = this.sortedRuns().map((run) => ({ kind: 'run' as const, run })));
    const collapsed = new Set(this.s.collapsedGroups);
    const items: TableItem[] = [];
    groups.forEach((group, i) => {
      const isCollapsed = collapsed.has(group.label);
      items.push({ kind: 'group', group, color: i % PALETTE_SIZE, collapsed: isCollapsed });
      if (!isCollapsed) for (const run of group.runs) items.push({ kind: 'run', run });
    });
    return (this.cache.items = items);
  }

  /** Palette index per group label for a grouping field, following group display order. */
  groupColorIndex(field: string, runs: readonly RunSummary[] = this.filteredRuns()): Map<string, number> {
    return new Map(groupRuns(runs, field).map((g, i) => [g.label, i % PALETTE_SIZE]));
  }

  fieldLabel(id: string): string {
    const c = this.availableColumns().find((x) => x.id === id);
    if (!c) return id;
    return c.kind === 'param' ? `param ${c.key}` : c.label;
  }

  /** Numeric run-level fields usable as scatter axes / box values. */
  numericFields(): ColumnDef[] {
    return this.availableColumns().filter((c) => c.numeric && c.id !== 'status');
  }

  /** Fields usable for grouping (categorical or discrete). */
  groupFields(): ColumnDef[] {
    const fixed = new Set(['status', 'group', 'tags', 'name']);
    return this.availableColumns().filter((c) => (c.kind === 'fixed' ? fixed.has(c.key) : c.kind === 'param' || (c.kind === 'summary' && !c.numeric)));
  }

  /** All columns available in the chooser. */
  availableColumns(): ColumnDef[] {
    return (this.cache.columns ??= [...FIXED_COLUMNS, ...OPTIONAL_FIXED_COLUMNS, ...dynamicColumns(this.allRuns())]);
  }

  visibleColumns(): ColumnDef[] {
    const avail = new Map(this.availableColumns().map((c) => [c.id, c]));
    const ids = this.s.visibleColumns ?? defaultVisibleColumns(this.filteredRuns());
    let cols = ids.flatMap((id) => {
      const c = avail.get(id);
      return c ? [c] : [];
    });
    if (this.s.differingOnly) {
      const diff = new Set(differingParams(this.filteredRuns()));
      cols = cols.filter((c) => c.kind !== 'param' || diff.has(c.key));
      // With "differing only", also surface differing params that are not explicitly chosen.
      if (this.s.visibleColumns === null) {
        const shown = new Set(cols.map((c) => c.id));
        for (const k of diff) {
          const c = avail.get(`param:${k}`);
          if (c && !shown.has(c.id)) cols.push(c);
        }
      }
    }
    return cols;
  }

  selectedRuns(): RunSummary[] {
    return this.s.selected.flatMap((k) => {
      const r = this.runs.get(k);
      return r ? [r] : [];
    });
  }

  plottedRuns(): RunSummary[] {
    return this.selectedRuns().slice(0, MAX_PLOT_RUNS);
  }

  // -- selection -------------------------------------------------------------------

  setSelected(keys: string[]): void {
    this.s.selected = [...new Set(keys)];
    for (const k of this.s.selected) this.colorIndex(k);
    this.changed('selection', 'table', 'plots', 'detail', 'toolbar');
    this.requestSeries();
  }

  toggleSelected(key: string, on?: boolean): void {
    const has = this.s.selected.includes(key);
    const want = on ?? !has;
    if (want === has) return;
    this.setSelected(want ? [...this.s.selected, key] : this.s.selected.filter((k) => k !== key));
  }

  /** Stable run -> palette index: assigned on first selection, reusing the least-used index. */
  colorIndex(key: string): number {
    const existing = this.s.colors[key];
    if (existing !== undefined) return existing;
    const used = new Map<number, number>();
    for (const k of this.s.selected) {
      const c = this.s.colors[k];
      if (c !== undefined) used.set(c, (used.get(c) ?? 0) + 1);
    }
    let best = 0;
    for (let i = 0; i < PALETTE_SIZE; i++) if ((used.get(i) ?? 0) < (used.get(best) ?? 0)) best = i;
    this.s.colors[key] = best;
    // bound the map: forget colours of runs that no longer exist
    const keys = Object.keys(this.s.colors);
    if (keys.length > 2000) for (const k of keys) if (!this.runs.has(k)) delete this.s.colors[k];
    return best;
  }

  focus(key: string | null): void {
    if (this.s.focused === key) return;
    this.s.focused = key;
    this.detail = null;
    this.changed('table', 'detail', 'nav', 'plots');
    this.requestDetail();
  }

  navigate(view: AppView): void {
    if (this.s.view === view) return;
    this.s.view = view;
    this.changed('nav', 'detail', 'plots', 'table', 'toolbar');
  }

  refreshNow(): void {
    this.refreshing = true;
    this.post({ type: 'refreshNow' });
    this.changed('status');
  }

  /** Number of active filter conditions (search, statuses, column expressions). */
  activeFilterCount(): number {
    const f = this.s.filters;
    return (f.search.trim() ? 1 : 0) + f.statuses.length + Object.values(f.columns).filter((v) => v.trim()).length;
  }

  clearFilters(): void {
    this.s.filters = { search: '', statuses: [], columns: {} };
    this.changed('table', 'toolbar', 'plots', 'nav');
  }

  requestDetail(): void {
    if (this.s.focused) this.post({ type: 'requestDetail', runKey: this.s.focused });
  }

  // -- plotting ----------------------------------------------------------------------

  /** All metric names of the selected runs (or of all runs when nothing is selected). */
  availableMetrics(): string[] {
    const src = this.s.selected.length ? this.selectedRuns() : this.allRuns();
    return [...new Set(src.flatMap((r) => r.metricNames))].sort();
  }

  plotMetrics(): string[] {
    if (this.s.plot.metrics) return this.s.plot.metrics;
    const avail = this.availableMetrics();
    const preferred = ['train/loss', 'val/loss', 'val/auc'].filter((m) => avail.includes(m));
    return preferred.length ? preferred : avail.slice(0, 2);
  }

  private lastSeriesRequest = '';

  /** Sends the current plot subscription to the host (no-op if unchanged). */
  requestSeries(): void {
    // Use the selection itself (not only known runs) so a restored selection is requested before the first scan.
    const runKeys = this.s.selected.filter((k) => !this.loaded || this.runs.has(k)).slice(0, MAX_PLOT_RUNS);
    const metrics = this.plotMetrics();
    const key = JSON.stringify([runKeys, metrics]);
    if (key === this.lastSeriesRequest) return;
    this.lastSeriesRequest = key;
    const wanted = new Set(runKeys.flatMap((k) => metrics.map((m) => seriesId(k, m))));
    for (const id of [...this.series.keys()]) if (!wanted.has(id)) this.series.delete(id);
    this.post({ type: 'requestSeries', runKeys, metrics });
  }

  isParamColumn(id: string): boolean {
    return parseColumnId(id).kind === 'param';
  }
}

/** UI state injected by the host into the page (see extension.ts html()); null when absent. */
function readHostState(): unknown {
  try {
    const el = document.getElementById('traceml-state');
    return el?.textContent ? JSON.parse(el.textContent) : null;
  } catch {
    return null;
  }
}

export function seriesId(runKey: string, metric: string): string {
  return `${runKey}\u0000${metric}`;
}
