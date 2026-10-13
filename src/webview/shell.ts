// Application shell: persistent sidebar (navigation, run roots, selection, settings), header, view
// host and the run inspector panel.
import { DISPLAY_STATUSES, type DisplayStatus } from '../types';
import { formatTimeFull, h } from './dom';
import { openHiddenRuns } from './filters';
import type { AppState, AppView, Area } from './state';
import { button, icon } from './ui';

const NAV: { id: AppView; label: string; icon: string }[] = [
  { id: 'overview', label: 'Overview', icon: 'overview' },
  { id: 'runs', label: 'Runs', icon: 'runs' },
  { id: 'compare', label: 'Compare', icon: 'compare' },
];

/** Column-filter expression that matches runs located directly under a runs root. */
export function rootFilterExpr(root: string): string {
  const escaped = root.replace(/[.*+?^${}()|[\]\\/]/g, (c) => '\\' + c);
  return '/^' + escaped + '\\//';
}

/** TraceML logo (media/curly_m.svg, shown white by CSS), sized by CSS; falls back to a line icon. */
function brandLogo(): Node {
  const src = document.querySelector<HTMLMetaElement>('meta[name="traceml-logo"]')?.content;
  return src ? h('img', { src, alt: 'TraceML logo', class: 'brand-logo' }) : icon('activity', 16);
}

const TITLES: Record<AppView, string> = { overview: 'Overview', runs: 'Runs', compare: 'Compare' };

export class Shell {
  readonly el: HTMLElement;
  readonly viewHost: HTMLElement;
  readonly inspector: HTMLElement;
  private readonly sidebar: HTMLElement;
  private readonly navEl = h('nav', { class: 'nav', 'aria-label': 'TraceML' });
  private readonly rootsEl = h('div', { class: 'side-list' });
  private readonly selectedEl = h('div', { class: 'side-selected' });
  private readonly headerTitle = h('div', { class: 'crumbs' });
  private readonly headerStatus = h('div', { class: 'header-status' });
  private readonly refreshed = h('span', { class: 'refreshed' });
  private readonly refreshBtn: HTMLButtonElement;
  private readonly dashboardBtn: HTMLButtonElement;
  private readonly errorBar = h('div', { class: 'error-bar', role: 'alert' });
  private readonly noticeBar = h('div', { class: 'export-bar notice-bar', role: 'status' });
  private noticeKey = '';
  private readonly views = new Map<AppView, HTMLElement>();
  private sideKey = '';

  constructor(private readonly st: AppState) {
    const collapseBtn = button({ icon: 'chevronLeft', title: 'Collapse sidebar', variant: 'ghost', cls: 'collapse-btn', onClick: () => this.toggleSidebar() });
    const settings = h('button', { type: 'button', class: 'nav-item', title: 'TraceML settings' }, icon('settings'), h('span', { class: 'nav-label' }, 'Settings'));
    settings.addEventListener('click', () => st.post({ type: 'openSettings' }));
    settings.hidden = !!st.snapshot;

    this.sidebar = h(
      'aside',
      { class: 'sidebar', 'aria-label': 'Sidebar' },
      h('div', { class: 'brand' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, brandLogo()), h('span', { class: 'brand-name' }, 'TraceML'), collapseBtn),
      this.navEl,
      h('div', { class: 'side-sep' }),
      h('div', { class: 'side-section' }, h('div', { class: 'side-title' }, 'Run roots'), this.rootsEl),
      h('div', { class: 'side-sep' }),
      h('div', { class: 'side-section' }, h('div', { class: 'side-title' }, 'Selected'), this.selectedEl),
      h('div', { class: 'spacer' }),
      h('div', { class: 'side-sep' }),
      h('div', { class: 'nav side-bottom' }, settings),
    );

    this.refreshBtn = button({ label: 'Refresh', icon: 'refresh', variant: 'secondary', title: 'Rescan runs now', onClick: () => st.refreshNow() });
    this.dashboardBtn = button({
      label: 'Export dashboard',
      icon: 'download',
      variant: 'secondary',
      title: 'Save this dashboard as one HTML file anyone can open in a browser (no VS Code, no runs folder): the filtered runs, charts of the selected runs, and the current view. Saved in the TraceML cache folder.',
      onClick: () => st.exportDashboard(),
    });
    // An exported dashboard is a read-only snapshot: no rescans, no re-export.
    const snapshotBadge = st.snapshot
      ? h('span', { class: 'snapshot-badge', title: 'Read-only snapshot exported from TraceML. Charts are included for the runs that were selected at export time.' }, `Snapshot · exported ${st.snapshot.slice(0, 16).replace('T', ' ')} UTC`)
      : null;
    const header = h(
      'header',
      { class: 'app-header' },
      this.headerTitle,
      h('div', { class: 'spacer' }),
      this.headerStatus,
      snapshotBadge ?? this.refreshed,
      st.snapshot ? null : this.dashboardBtn,
      st.snapshot ? null : this.refreshBtn,
    );
    this.errorBar.hidden = true;
    this.noticeBar.hidden = true;
    this.viewHost = h('main', { class: 'view-host', id: 'main' });
    this.inspector = h('aside', { class: 'inspector', 'aria-label': 'Run details' });
    this.inspector.hidden = true;
    this.el = h(
      'div',
      { class: 'shell' },
      this.sidebar,
      h('div', { class: 'main' }, header, this.errorBar, this.noticeBar, h('div', { class: 'main-body' }, this.viewHost, this.inspector)),
    );

    // Auto-collapse to an icon rail when the panel is narrow.
    const mq = window.matchMedia('(max-width: 820px)');
    const applyCollapse = () => this.el.classList.toggle('collapsed', st.s.sidebarCollapsed || mq.matches);
    mq.addEventListener('change', applyCollapse);
    applyCollapse();
    setInterval(() => this.renderRefreshed(), 1000);
  }

  addView(id: AppView, el: HTMLElement): void {
    el.classList.add('view');
    el.dataset.view = id;
    this.views.set(id, el);
    this.viewHost.append(el);
  }

  private toggleSidebar(): void {
    this.st.s.sidebarCollapsed = !this.st.s.sidebarCollapsed;
    this.el.classList.toggle('collapsed', this.st.s.sidebarCollapsed || window.matchMedia('(max-width: 820px)').matches);
    this.st.changed('nav');
  }

  render(areas: Set<Area>): void {
    for (const [id, el] of this.views) el.hidden = id !== this.st.s.view;
    this.renderSidebar();
    this.renderHeader();
    this.renderRefreshed();
    this.renderError();
    this.renderNotice();
    const collapseBtn = this.sidebar.querySelector<HTMLButtonElement>('.collapse-btn');
    if (collapseBtn) {
      collapseBtn.title = this.st.s.sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar';
      collapseBtn.setAttribute('aria-label', collapseBtn.title);
      collapseBtn.replaceChildren(icon(this.st.s.sidebarCollapsed ? 'chevronRight' : 'chevronLeft', 15));
    }
    void areas;
  }

  private renderSidebar(): void {
    const all = this.st.allRuns();
    const selected = this.st.selectedRuns().length;
    const locFilter = this.st.s.filters.columns.location ?? '';
    const rootCounts = this.st.roots.map((r) => [r, all.filter((x) => x.location.startsWith(r + '/') || x.location === r).length] as const);
    const key = JSON.stringify([this.st.s.view, selected, rootCounts, locFilter, all.length]);
    if (key === this.sideKey) return;
    this.sideKey = key;

    this.navEl.replaceChildren(
      ...NAV.map((n) => {
        const active = n.id === this.st.s.view;
        const count = n.id === 'runs' ? all.length : n.id === 'compare' ? selected : null;
        const b = h(
          'button',
          { type: 'button', class: `nav-item${active ? ' active' : ''}`, 'aria-current': active ? 'page' : null, title: n.label },
          icon(n.icon),
          h('span', { class: 'nav-label' }, n.label),
          count !== null && count > 0 ? h('span', { class: 'nav-count' }, String(count)) : null,
        );
        b.addEventListener('click', () => this.st.navigate(n.id));
        return b;
      }),
    );

    this.rootsEl.replaceChildren(
      ...(rootCounts.length
        ? rootCounts.map(([r, n]) => {
            const active = locFilter === rootFilterExpr(r);
            const b = h(
              'button',
              { type: 'button', class: `side-item${active ? ' active' : ''}`, title: active ? `Showing only ${r} (click to show all)` : `Show only runs under ${r}` },
              icon('folder', 14),
              h('span', { class: 'side-item-label' }, r),
              h('span', { class: 'nav-count' }, String(n)),
            );
            b.addEventListener('click', () => {
              if (active) delete this.st.s.filters.columns.location;
              else this.st.s.filters.columns.location = rootFilterExpr(r);
              this.st.navigate('runs');
              this.st.changed('table', 'toolbar', 'plots', 'nav');
            });
            return b;
          })
        : [h('div', { class: 'side-empty' }, this.st.loaded ? 'No runs roots found' : 'Scanning…')]),
    );

    const compare = h('button', { type: 'button', class: 'side-item', disabled: selected < 2, title: selected < 2 ? 'Select at least two runs to compare' : 'Compare selected runs' }, icon('compare', 14), h('span', { class: 'side-item-label' }, 'Compare'));
    compare.addEventListener('click', () => this.st.navigate('compare'));
    const clear = h('button', { type: 'button', class: 'side-item', disabled: selected === 0, title: 'Clear selection' }, icon('close', 14), h('span', { class: 'side-item-label' }, 'Clear'));
    clear.addEventListener('click', () => this.st.setSelected([]));
    this.selectedEl.replaceChildren(
      h('div', { class: 'side-stat', title: `${selected} selected run${selected === 1 ? '' : 's'}` }, icon('selected', 14), h('span', { class: 'side-item-label' }, selected ? `${selected} run${selected === 1 ? '' : 's'}` : 'None')),
      selected ? h('div', { class: 'side-actions' }, compare, clear) : '',
    );
  }

  private renderHeader(): void {
    const all = this.st.allRuns();
    const counts = new Map<DisplayStatus, number>();
    for (const r of all) counts.set(r.displayStatus, (counts.get(r.displayStatus) ?? 0) + 1);
    this.headerTitle.replaceChildren(
      h('span', { class: 'crumb-root' }, 'TraceML'),
      h('span', { class: 'crumb-sep', 'aria-hidden': 'true' }, '/'),
      h('h1', { class: 'crumb-current' }, TITLES[this.st.s.view]),
    );
    const important: DisplayStatus[] = ['running', 'stale', 'failed'];
    this.headerStatus.replaceChildren(
      h('span', { class: 'header-count' }, `${all.length} runs`),
      ...DISPLAY_STATUSES.filter((s) => important.includes(s) && counts.get(s)).map((s) =>
        h('span', { class: `status st-${s} status-plain`, title: `${counts.get(s)} ${s}` }, h('span', { class: 'dot', 'aria-hidden': 'true' }), `${counts.get(s)} ${s}`),
      ),
    );
  }

  private renderRefreshed(): void {
    const t = this.st.refreshedAt;
    this.refreshed.replaceChildren(
      this.st.refreshing || !t ? h('span', { class: 'spinner small', 'aria-hidden': 'true' }) : '',
      h('span', {}, t ? `Last refreshed ${formatTimeFull(t).slice(11)}` : 'Scanning…'),
    );
    this.refreshed.title = `Polling every ${this.st.config.refreshIntervalSeconds}s`;
    this.refreshBtn.disabled = this.st.refreshing;
    this.dashboardBtn.disabled = this.st.exportingDashboard;
    this.dashboardBtn.classList.toggle('busy', this.st.exportingDashboard);
  }

  /** Result of the last export / plot save / delete, with Copy path / Open / Undo actions. */
  private renderNotice(): void {
    const n = this.st.notice;
    const key = JSON.stringify([n, this.st.hiddenRuns.length]);
    if (key === this.noticeKey) return;
    this.noticeKey = key;
    this.noticeBar.hidden = !n;
    if (!n) return;
    const dismiss = button({ icon: 'close', title: 'Dismiss', variant: 'ghost', onClick: () => {
      this.st.notice = null;
      this.st.changed('status');
    } });
    const path = (p: string, title: string) => h('code', { class: 'export-path', title }, p);
    let parts: (Node | string)[];
    if (n.kind === 'export') {
      parts = [
        icon('file', 15),
        h('span', {}, `Exported ${n.rows} row${n.rows === 1 ? '' : 's'} as CSV to `),
        path(n.path, 'Give this path to an agent'),
        button({ label: 'Copy path', icon: 'check', variant: 'secondary', cls: 'btn-small', onClick: () => this.st.post({ type: 'copyExportPath' }) }),
        button({ label: 'Open', variant: 'ghost', cls: 'btn-small', title: 'Open the CSV (read-only)', onClick: () => this.st.post({ type: 'openExport' }) }),
      ];
    } else if (n.kind === 'plot') {
      parts = [
        icon('download', 15),
        h('span', {}, `Saved PNG (${n.width}×${n.height} px, 300 DPI) to `),
        path(n.path, 'Saved plot'),
        button({ label: 'Copy path', icon: 'check', variant: 'secondary', cls: 'btn-small', onClick: () => this.st.post({ type: 'copyPlotPath' }) }),
        button({ label: 'Open', variant: 'ghost', cls: 'btn-small', title: 'Open the image', onClick: () => this.st.post({ type: 'openPlot' }) }),
      ];
    } else if (n.kind === 'dashboard') {
      const size = n.bytes >= 1048576 ? `${(n.bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n.bytes / 1024))} KB`;
      parts = [
        icon('download', 15),
        h('span', {}, `Exported dashboard (${n.runs} run${n.runs === 1 ? '' : 's'}, charts for ${n.chartRuns}, ${size}) to `),
        path(n.path, 'One HTML file: send it or put it on a web server; it opens in any browser'),
        button({ label: 'Copy path', icon: 'check', variant: 'secondary', cls: 'btn-small', onClick: () => this.st.post({ type: 'copyDashboardPath' }) }),
        button({ label: 'Open in browser', variant: 'ghost', cls: 'btn-small', title: 'Open the dashboard in your default browser', onClick: () => this.st.post({ type: 'openDashboard' }) }),
      ];
    } else if (n.kind === 'plotData') {
      parts = [
        icon('file', 15),
        h('span', {}, `Saved chart data as CSV (${n.rows} row${n.rows === 1 ? '' : 's'}) to `),
        path(n.path, 'Give this path to an agent'),
        button({ label: 'Copy path', icon: 'check', variant: 'secondary', cls: 'btn-small', onClick: () => this.st.post({ type: 'copyPlotPath' }) }),
        button({ label: 'Open', variant: 'ghost', cls: 'btn-small', title: 'Open the CSV (read-only)', onClick: () => this.st.post({ type: 'openPlot' }) }),
      ];
    } else {
      const what = n.names.length === 1 ? `“${n.names[0]}”` : `${n.names.length} runs`;
      const listBtn: HTMLButtonElement = button({ label: `Deleted runs (${this.st.hiddenRuns.length})`, variant: 'ghost', cls: 'btn-small', onClick: () => openHiddenRuns(this.st, listBtn) });
      parts = [
        icon('trash', 15),
        h('span', {}, `Deleted ${what} from TraceML. The run folder${n.names.length === 1 ? ' was' : 's were'} not touched.`),
        button({ label: 'Undo', variant: 'secondary', cls: 'btn-small', onClick: () => this.st.unhideRuns(n.keys) }),
        listBtn,
      ];
    }
    this.noticeBar.replaceChildren(...parts, h('span', { class: 'spacer' }), dismiss);
  }

  private renderError(): void {
    this.errorBar.hidden = !this.st.error;
    if (!this.st.error) return;
    const close = button({ icon: 'close', title: 'Dismiss', variant: 'ghost', onClick: () => {
      this.st.error = null;
      this.st.changed('status');
    } });
    this.errorBar.replaceChildren(icon('warning', 15), h('span', { class: 'error-text' }, this.st.error), close);
  }
}
