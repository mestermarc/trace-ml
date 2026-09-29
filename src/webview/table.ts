// Virtualized run table: only rows in view exist in the DOM, and rows are keyed so a live refresh
// only rewrites rows whose content actually changed (no flicker, 1,000+ runs stay responsive).
import { parseColumnFilter } from '../model/filters';
import { columnValue, toggleSort, type ColumnDef } from '../model/run';
import type { RunSummary } from '../types';
import { esc, formatDuration, formatScalar, formatTime, h, nextFrame, palette } from './dom';
import type { AppState, Area, TableItem } from './state';
import { emptyState, iconHtml, statusHtml } from './ui';

const ROW_H = 30;
const OVERSCAN = 8;
const WIDTHS: Record<string, number> = { status: 112, name: 250, group: 130, started: 132, ended: 132, heartbeat: 132, duration: 86, step: 64, epoch: 64, id: 280, tags: 130, location: 280 };
const SELECT_W = 36;

function widthOf(c: ColumnDef): number {
  return c.kind === 'fixed' ? (WIDTHS[c.key] ?? 110) : Math.min(190, Math.max(92, c.key.length * 7 + 40));
}

function cellText(run: RunSummary, c: ColumnDef): string {
  const v = columnValue(run, c.id);
  if (c.kind === 'fixed') {
    switch (c.key) {
      case 'started':
      case 'ended':
      case 'heartbeat':
        return formatTime(v as number | null);
      case 'duration':
        return formatDuration(v as number | null);
    }
  }
  return formatScalar(v);
}

const TIME_KEYS = new Set(['started', 'ended', 'heartbeat', 'duration']);

export class RunTable {
  readonly el: HTMLElement;
  private readonly scroll: HTMLDivElement;
  private readonly head: HTMLDivElement;
  private readonly body: HTMLDivElement;
  private readonly empty: HTMLDivElement;
  private headKey = '';
  private cols: ColumnDef[] = [];
  private template = '';
  private lastClickedIndex = -1;
  private rafPending = false;
  private filterTimer: ReturnType<typeof setTimeout> | undefined;
  /** Rendered row elements keyed by run key / group label, with the HTML they were built from. */
  private rows = new Map<string, { el: HTMLDivElement; html: string }>();
  private emptyKey = '';

  constructor(private readonly st: AppState) {
    this.head = h('div', { class: 'thead', role: 'rowgroup' });
    this.body = h('div', { class: 'tbody', role: 'rowgroup' });
    this.empty = h('div', { class: 'table-empty' });
    this.scroll = h('div', { class: 'table-scroll', tabindex: 0, role: 'grid', 'aria-label': 'Runs table. Arrow keys move, Space selects, Enter opens details.' }, this.head, this.body);
    this.scroll.style.height = `${st.s.tableHeight}px`;
    this.el = h('section', { class: 'table-card' }, this.scroll, this.empty);

    this.scroll.addEventListener('scroll', () => this.scheduleRows(), { passive: true });
    this.body.addEventListener('click', (e) => this.onBodyClick(e as MouseEvent));
    this.scroll.addEventListener('keydown', (e) => this.onKey(e));
    new ResizeObserver(() => {
      const hgt = Math.round(this.scroll.getBoundingClientRect().height);
      if (hgt > 0 && hgt !== this.st.s.tableHeight) this.st.s.tableHeight = hgt;
      this.scheduleRows();
    }).observe(this.scroll);
  }

  render(areas: Set<Area>): void {
    if (!(areas.has('runs') || areas.has('table') || areas.has('selection') || areas.has('nav'))) return;
    if (this.st.s.view !== 'runs') return;
    this.cols = this.st.visibleColumns();
    this.template = [SELECT_W, ...this.cols.map(widthOf)].map((w) => `${w}px`).join(' ');
    const key = JSON.stringify([this.cols.map((c) => c.id), this.st.s.sort, this.st.s.showFilterRow]);
    if (key !== this.headKey) {
      this.headKey = key;
      this.renderHead();
      this.rows.forEach((r) => r.el.remove());
      this.rows.clear();
    }
    this.updateHeadState();
    this.renderEmpty();
    this.renderRows();
  }

  // -- header --------------------------------------------------------------------

  private renderHead(): void {
    const focusedCol = (document.activeElement as HTMLElement | null)?.dataset?.filterCol;
    const selStart = (document.activeElement as HTMLInputElement | null)?.selectionStart ?? null;
    const totalW = SELECT_W + this.cols.reduce((a, c) => a + widthOf(c), 0);
    this.head.style.minWidth = this.body.style.minWidth = `${totalW}px`;

    const selectAll = h('input', { type: 'checkbox', class: 'cb', title: 'Select / clear all filtered runs', 'aria-label': 'Select all filtered runs' });
    selectAll.addEventListener('change', () => {
      const filtered = this.st.sortedRuns().map((r) => r.key);
      if (selectAll.checked) this.st.setSelected([...this.st.s.selected, ...filtered]);
      else {
        const f = new Set(filtered);
        this.st.setSelected(this.st.s.selected.filter((k) => !f.has(k)));
      }
    });

    const headRow = h('div', { class: 'tr th-row', role: 'row' }, h('div', { class: 'th sel' }, selectAll));
    headRow.style.gridTemplateColumns = this.template;
    const filterRow = h('div', { class: 'tr filter-row', role: 'row' }, h('div', { class: 'th sel' }));
    filterRow.style.gridTemplateColumns = this.template;

    for (const c of this.cols) {
      const sortIdx = this.st.s.sort.findIndex((k) => k.col === c.id);
      const sortKey = this.st.s.sort[sortIdx];
      const th = h('button', {
        type: 'button',
        class: `th${c.numeric ? ' num' : ''}${sortKey ? ' sorted' : ''}`,
        title: `${c.label}\nClick to sort · Shift+click to add a sort key`,
        role: 'columnheader',
        'aria-sort': sortKey ? (sortKey.dir === 'asc' ? 'ascending' : 'descending') : 'none',
      });
      if (c.kind !== 'fixed') th.append(h('span', { class: `kind kind-${c.kind}` }, c.kind === 'summary' ? 'sum' : c.kind));
      th.append(h('span', { class: 'label' }, c.kind === 'fixed' ? c.label : c.key));
      const sortEl = h('span', { class: 'sort', 'aria-hidden': 'true' });
      if (sortKey) sortEl.innerHTML = iconHtml(sortKey.dir === 'asc' ? 'arrowUp' : 'arrowDown', 12) + (this.st.s.sort.length > 1 ? `<sub>${sortIdx + 1}</sub>` : '');
      th.append(sortEl);
      th.addEventListener('click', (e) => {
        this.st.s.sort = toggleSort(this.st.s.sort, c.id, (e as MouseEvent).shiftKey);
        this.st.changed('table');
      });
      headRow.append(th);

      const input = h('input', {
        type: 'text',
        class: 'col-filter',
        placeholder: c.numeric ? '> 0.8' : 'filter',
        value: this.st.s.filters.columns[c.id] ?? '',
        'aria-label': `Filter ${c.label}`,
        spellcheck: 'false',
      });
      input.dataset.filterCol = c.id;
      input.addEventListener('input', () => {
        const v = input.value;
        if (v.trim()) this.st.s.filters.columns[c.id] = v;
        else delete this.st.s.filters.columns[c.id];
        const err = parseColumnFilter(v).error;
        input.classList.toggle('invalid', err !== null);
        input.title = err ?? '';
        clearTimeout(this.filterTimer);
        this.filterTimer = setTimeout(() => this.st.changed('table', 'toolbar', 'plots', 'nav'), 150);
      });
      filterRow.append(h('div', { class: 'th' }, input));
    }
    this.head.replaceChildren(headRow, ...(this.st.s.showFilterRow ? [filterRow] : []));

    if (focusedCol) {
      const inp = this.head.querySelector<HTMLInputElement>(`input[data-filter-col="${CSS.escape(focusedCol)}"]`);
      if (inp) {
        inp.focus();
        if (selStart !== null) inp.setSelectionRange(selStart, selStart);
      }
    }
  }

  private updateHeadState(): void {
    const all = this.head.querySelector<HTMLInputElement>('.th-row input[type=checkbox]');
    if (all) {
      const filtered = this.st.sortedRuns();
      const sel = new Set(this.st.s.selected);
      const n = filtered.filter((r) => sel.has(r.key)).length;
      all.checked = n > 0 && n === filtered.length;
      all.indeterminate = n > 0 && n < filtered.length;
    }
    for (const inp of this.head.querySelectorAll<HTMLInputElement>('input.col-filter')) {
      const v = this.st.s.filters.columns[inp.dataset.filterCol ?? ''] ?? '';
      if (document.activeElement !== inp && inp.value !== v) inp.value = v;
      inp.classList.toggle('invalid', parseColumnFilter(inp.value).error !== null);
    }
  }

  private renderEmpty(): void {
    const all = this.st.allRuns().length;
    const shown = this.st.sortedRuns().length;
    const state = !this.st.loaded && all === 0 ? 'scanning' : all === 0 ? 'none' : shown === 0 ? 'nomatch' : '';
    const key = state + this.st.roots.join('|');
    if (key === this.emptyKey) return;
    this.emptyKey = key;
    let el: HTMLElement | null = null;
    if (state === 'scanning') el = emptyState({ busy: true, title: 'Scanning for runs…', text: 'Looking for directories matching traceml.roots.' });
    else if (state === 'none')
      el = emptyState({
        icon: 'inbox',
        title: 'No experiments found',
        text: this.st.roots.length
          ? `TraceML found runs roots (${this.st.roots.join(', ')}) but no run directories in them. A run directory contains run.json, metrics.json, metrics.jsonl, params.yaml or config.json.`
          : 'TraceML did not find any runs under the configured roots. Check the traceml.roots setting.',
        action: { label: 'Refresh', icon: 'refresh', onClick: () => this.st.refreshNow() },
      });
    else if (state === 'nomatch') el = emptyState({ icon: 'filter', title: 'No runs match the filters', text: 'Adjust the search or remove some filters.', action: { label: 'Clear filters', onClick: () => this.st.clearFilters() } });
    this.empty.replaceChildren(...(el ? [el] : []));
    this.empty.hidden = !el;
    this.scroll.hidden = !!el && state !== 'nomatch';
  }

  // -- rows ----------------------------------------------------------------------

  private scheduleRows(): void {
    if (this.rafPending) return;
    this.rafPending = true;
    nextFrame(() => {
      this.rafPending = false;
      this.renderRows();
    });
  }

  private itemKey(it: TableItem): string {
    return it.kind === 'group' ? `\u0001group:${it.group.label}` : it.run.key;
  }

  private renderRows(): void {
    const items = this.st.tableItems();
    this.body.style.height = `${items.length * ROW_H}px`;
    const headH = this.head.offsetHeight;
    const top = Math.max(0, this.scroll.scrollTop - headH);
    const first = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
    const last = Math.min(items.length, Math.ceil((top + this.scroll.clientHeight) / ROW_H) + OVERSCAN);
    const sel = new Set(this.st.s.selected);
    const colors = palette();
    const groupField = this.st.s.groupBy ? this.st.fieldLabel(this.st.s.groupBy) : '';
    const next = new Map<string, { el: HTMLDivElement; html: string }>();

    for (let i = first; i < last; i++) {
      const it = items[i]!;
      const key = this.itemKey(it);
      let cls: string;
      let html: string;
      let label: string;
      if (it.kind === 'group') {
        const g = it.group;
        const nSel = g.runs.filter((r) => sel.has(r.key)).length;
        const allSel = nSel > 0 && nSel === g.runs.length;
        cls = 'tr row group-row';
        label = `Group ${g.label}`;
        html =
          `<div class="td sel"><input class="cb" type="checkbox" data-act="sel" aria-label="Select group ${esc(g.label)}"${allSel ? ' checked' : ''}></div>` +
          `<div class="group-label" title="Click to ${it.collapsed ? 'expand' : 'collapse'}">${iconHtml(it.collapsed ? 'chevronRight' : 'chevronDown', 14)}<span class="swatch" style="background:${colors[it.color]}"></span>` +
          `<span class="muted">${esc(groupField)}</span><b>${esc(g.label)}</b><span class="group-count">${g.runs.length} run${g.runs.length === 1 ? '' : 's'}${nSel ? ` · ${nSel} selected` : ''}</span></div>`;
      } else {
        const r = it.run;
        const selected = sel.has(r.key);
        cls = `tr row${selected ? ' selected' : ''}${r.key === this.st.s.focused ? ' focused' : ''}`;
        label = r.name;
        const swatch = selected ? `<span class="row-swatch" style="background:${colors[this.st.colorIndex(r.key)] ?? 'currentColor'}"></span>` : '';
        html = `<div class="td sel">${swatch}<input class="cb" type="checkbox" data-act="sel" aria-label="Select ${esc(r.name)}"${selected ? ' checked' : ''}></div>`;
        for (const c of this.cols) html += this.cellHtml(r, c);
      }
      let row = this.rows.get(key);
      if (!row) {
        const el = document.createElement('div');
        el.setAttribute('role', 'row');
        row = { el, html: '' };
        this.body.append(el);
      }
      if (row.html !== html) {
        row.el.innerHTML = html;
        row.html = html;
      }
      if (row.el.className !== cls) row.el.className = cls;
      row.el.dataset.i = String(i);
      row.el.setAttribute('aria-label', label);
      row.el.style.top = `${i * ROW_H}px`;
      if (it.kind === 'run') row.el.style.gridTemplateColumns = this.template;
      next.set(key, row);
    }
    for (const [k, r] of this.rows) if (!next.has(k)) r.el.remove();
    this.rows = next;
  }

  private cellHtml(r: RunSummary, c: ColumnDef): string {
    if (c.kind === 'fixed' && c.key === 'status') {
      const unknownHb = r.displayStatus === 'running' && !r.heartbeatKnown;
      return `<div class="td">${statusHtml(r.displayStatus, unknownHb ? '?' : '', unknownHb ? 'running — no heartbeat_at, staleness cannot be checked' : r.displayStatus)}</div>`;
    }
    if (c.kind === 'fixed' && c.key === 'name') {
      const warn = r.warnings.length
        ? `<span class="file-warn" role="img" aria-label="File problems: ${esc(r.warnings.join('; '))}" title="${esc(r.warnings.join('\n'))}">${iconHtml('warning', 13)}</span>`
        : '';
      return `<div class="td name" title="${esc(`${r.name}\n${r.id}\n${r.location}`)}"><span class="name-text">${esc(r.name)}</span>${warn}</div>`;
    }
    const text = cellText(r, c);
    const cls = `td${c.numeric ? ' num' : ''}${c.kind === 'fixed' && TIME_KEYS.has(c.key) ? ' time' : ''}${c.kind === 'fixed' && c.key === 'group' ? ' secondary' : ''}${text === '' ? ' empty-cell' : ''}`;
    return `<div class="${cls}" title="${esc(text)}">${text === '' ? '—' : esc(text)}</div>`;
  }

  // -- interaction -------------------------------------------------------------------

  /** Index (in tableItems) of the run rows, used for shift-range selection and keyboard navigation. */
  private runItems(): { i: number; run: RunSummary }[] {
    const out: { i: number; run: RunSummary }[] = [];
    this.st.tableItems().forEach((it, i) => {
      if (it.kind === 'run') out.push({ i, run: it.run });
    });
    return out;
  }

  private onBodyClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    const row = target.closest<HTMLElement>('.row');
    if (!row) return;
    const i = Number(row.dataset.i);
    const item = this.st.tableItems()[i];
    if (!item) return;
    if (item.kind === 'group') {
      const keys = item.group.runs.map((r) => r.key);
      if ((target as HTMLInputElement).dataset.act === 'sel') {
        const set = new Set(keys);
        const on = (target as HTMLInputElement).checked;
        this.st.setSelected(on ? [...this.st.s.selected, ...keys] : this.st.s.selected.filter((k) => !set.has(k)));
        return;
      }
      const collapsed = new Set(this.st.s.collapsedGroups);
      if (collapsed.has(item.group.label)) collapsed.delete(item.group.label);
      else collapsed.add(item.group.label);
      this.st.s.collapsedGroups = [...collapsed];
      this.st.changed('table');
      return;
    }
    const run = item.run;
    if (target.closest('.sel')) {
      if ((target as HTMLInputElement).dataset.act !== 'sel') return;
      const on = (target as HTMLInputElement).checked;
      if (e.shiftKey && this.lastClickedIndex >= 0) {
        const [a, b] = [Math.min(this.lastClickedIndex, i), Math.max(this.lastClickedIndex, i)];
        const range = this.runItems()
          .filter((x) => x.i >= a && x.i <= b)
          .map((x) => x.run.key);
        const set = new Set(this.st.s.selected);
        const keys = on ? [...this.st.s.selected, ...range.filter((k) => !set.has(k))] : this.st.s.selected.filter((k) => !range.includes(k));
        this.st.setSelected(keys);
      } else {
        this.st.toggleSelected(run.key, on);
      }
      this.lastClickedIndex = i;
      return;
    }
    this.st.focus(run.key);
    this.scroll.focus({ preventScroll: true });
  }

  private onKey(e: KeyboardEvent): void {
    if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'BUTTON') return;
    const runs = this.runItems();
    if (!runs.length) return;
    const cur = runs.findIndex((r) => r.run.key === this.st.s.focused);
    let next = cur;
    if (e.key === 'ArrowDown') next = Math.min(runs.length - 1, cur + 1);
    else if (e.key === 'ArrowUp') next = Math.max(0, cur - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = runs.length - 1;
    else if (e.key === ' ' && cur >= 0) {
      e.preventDefault();
      this.st.toggleSelected(runs[cur]!.run.key);
      return;
    } else if (e.key === 'Escape' && this.st.s.focused) {
      this.st.focus(null);
      return;
    } else return;
    e.preventDefault();
    this.st.focus(runs[next]!.run.key);
    this.scrollIntoView(runs[next]!.i);
  }

  /** Scrolls the table so the given run is visible (used when a plot point is clicked). */
  reveal(key: string): void {
    const it = this.runItems().find((x) => x.run.key === key);
    if (it) this.scrollIntoView(it.i);
  }

  private scrollIntoView(i: number): void {
    const headH = this.head.offsetHeight;
    const y = i * ROW_H;
    const viewTop = this.scroll.scrollTop;
    const viewH = this.scroll.clientHeight - headH;
    if (y < viewTop) this.scroll.scrollTop = y;
    else if (y + ROW_H > viewTop + viewH) this.scroll.scrollTop = y + ROW_H - viewH;
  }
}
