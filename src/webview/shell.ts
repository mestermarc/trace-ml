// Application shell: persistent sidebar (navigation, run roots, selection, settings), header, view
// host and the run inspector panel.
import { DISPLAY_STATUSES, type DisplayStatus } from '../types';
import { formatTimeFull, h } from './dom';
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
  private readonly errorBar = h('div', { class: 'error-bar', role: 'alert' });
  private readonly views = new Map<AppView, HTMLElement>();
  private sideKey = '';

  constructor(private readonly st: AppState) {
    const collapseBtn = button({ icon: 'chevronLeft', title: 'Collapse sidebar', variant: 'ghost', cls: 'collapse-btn', onClick: () => this.toggleSidebar() });
    const settings = h('button', { type: 'button', class: 'nav-item', title: 'TraceML settings' }, icon('settings'), h('span', { class: 'nav-label' }, 'Settings'));
    settings.addEventListener('click', () => st.post({ type: 'openSettings' }));

    this.sidebar = h(
      'aside',
      { class: 'sidebar', 'aria-label': 'Sidebar' },
      h('div', { class: 'brand' }, h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, icon('activity', 16)), h('span', { class: 'brand-name' }, 'TraceML'), collapseBtn),
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
    const header = h(
      'header',
      { class: 'app-header' },
      this.headerTitle,
      h('div', { class: 'spacer' }),
      this.headerStatus,
      this.refreshed,
      this.refreshBtn,
    );
    this.errorBar.hidden = true;
    this.viewHost = h('main', { class: 'view-host', id: 'main' });
    this.inspector = h('aside', { class: 'inspector', 'aria-label': 'Run details' });
    this.inspector.hidden = true;
    this.el = h(
      'div',
      { class: 'shell' },
      this.sidebar,
      h('div', { class: 'main' }, header, this.errorBar, h('div', { class: 'main-body' }, this.viewHost, this.inspector)),
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
