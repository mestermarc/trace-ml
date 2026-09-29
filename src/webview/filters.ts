// Runs toolbar: search, Filter / Group / Columns / More, status segment, differing-params switch
// and removable chips for every active filter.
import { defaultVisibleColumns, parseColumnFilter, selectFiltered } from '../model/filters';
import type { ColumnDef } from '../model/run';
import { DISPLAY_STATUSES, type DisplayStatus } from '../types';
import { h } from './dom';
import type { AppState, Area } from './state';
import { button, chip, icon, menu, openPopover, toggle } from './ui';

export const KIND_TITLES: Record<ColumnDef['kind'], string> = { fixed: 'Run', param: 'Parameters', last: 'Last', best: 'Best', summary: 'Summary' };

/** Human label of a column for chips / menus. */
export function columnLabel(c: ColumnDef): string {
  if (c.kind === 'last' || c.kind === 'best') return `${c.kind} ${c.key}`;
  return c.label;
}

/** <option>s for a field picker, grouped by column kind. `noneLabel` adds an empty choice. */
export function fieldOptions(fields: readonly ColumnDef[], current: string | null, noneLabel?: string): HTMLElement[] {
  const out: HTMLElement[] = [];
  if (noneLabel) out.push(h('option', { value: '' }, noneLabel));
  const groups = new Map<string, ColumnDef[]>();
  for (const f of fields) groups.set(KIND_TITLES[f.kind], [...(groups.get(KIND_TITLES[f.kind]) ?? []), f]);
  for (const [title, cols] of groups) {
    const og = h('optgroup', { label: title });
    for (const c of cols) og.append(h('option', { value: c.id, selected: c.id === current }, columnLabel(c)));
    out.push(og);
  }
  return out;
}

const SEGMENT: DisplayStatus[] = ['running', 'stale', 'completed', 'failed', 'killed', 'unknown'];

export class Toolbar {
  readonly el: HTMLElement;
  private readonly search: HTMLInputElement;
  private readonly searchClear: HTMLButtonElement;
  private readonly filterBtn: HTMLButtonElement;
  private readonly groupBtn: HTMLButtonElement;
  private readonly columnsBtn: HTMLButtonElement;
  private readonly segment = h('div', { class: 'segmented status-segment', role: 'group', 'aria-label': 'Filter by status' });
  private readonly differingHost = h('span', {});
  private readonly counts = h('span', { class: 'toolbar-counts' });
  private readonly chips = h('div', { class: 'filter-chips', 'aria-label': 'Active filters' });
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  private segKey = '';
  private chipsKey = '';
  private chooserFilter = '';

  constructor(private readonly st: AppState) {
    this.search = h('input', { type: 'search', class: 'search-input', placeholder: 'Search runs by name, id, group or tag…', value: st.s.filters.search, 'aria-label': 'Search runs', spellcheck: 'false' });
    this.searchClear = button({ icon: 'close', title: 'Clear search', variant: 'ghost', cls: 'search-clear', onClick: () => this.setSearch('') });
    this.search.addEventListener('input', () => {
      this.searchClear.hidden = !this.search.value;
      clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => this.setSearch(this.search.value, false), 120);
    });
    this.search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.search.value) {
        e.stopPropagation();
        this.setSearch('');
      }
    });

    this.filterBtn = button({ label: 'Filter', icon: 'filter', title: 'Column conditions (e.g. best val/auc > 0.8)', onClick: () => this.openFilter() });
    this.groupBtn = button({ label: 'Group', icon: 'group', title: 'Group runs by a field', onClick: () => this.openGroup() });
    this.columnsBtn = button({ label: 'Columns', icon: 'columns', title: 'Choose visible columns', onClick: () => this.openColumns() });
    const moreBtn: HTMLButtonElement = button({ icon: 'more', title: 'More actions', onClick: () => this.openMore(moreBtn) });
    for (const b of [this.filterBtn, this.groupBtn, this.columnsBtn, moreBtn]) b.setAttribute('aria-haspopup', 'true');

    const primary = h(
      'div',
      { class: 'toolbar-row' },
      h('div', { class: 'search' }, icon('search', 15), this.search, this.searchClear),
      h('div', { class: 'spacer' }),
      h('div', { class: 'btn-group' }, this.filterBtn, this.groupBtn, this.columnsBtn, moreBtn),
    );
    const secondary = h(
      'div',
      { class: 'toolbar-row' },
      this.segment,
      this.differingHost,
      h(
        'div',
        { class: 'toolbar-right' },
        this.counts,
        button({ label: 'Select filtered', icon: 'check', variant: 'ghost', cls: 'btn-small', title: 'Add all runs matching the filters to the selection', onClick: () => st.setSelected([...selectFiltered(new Set(st.s.selected), st.sortedRuns())]) }),
      ),
    );
    this.el = h('div', { class: 'toolbar' }, primary, secondary, this.chips);
  }

  private setSearch(v: string, syncInput = true): void {
    this.st.s.filters.search = v;
    if (syncInput) this.search.value = v;
    this.searchClear.hidden = !v;
    this.st.changed('table', 'toolbar', 'plots', 'nav');
  }

  render(areas: Set<Area>): void {
    if (!(areas.has('runs') || areas.has('table') || areas.has('toolbar') || areas.has('selection'))) return;
    if (document.activeElement !== this.search && this.search.value !== this.st.s.filters.search) this.search.value = this.st.s.filters.search;
    this.searchClear.hidden = !this.search.value;
    this.renderSegment();
    if (!this.differingHost.firstChild || (this.differingHost.querySelector('input') as HTMLInputElement).checked !== this.st.s.differingOnly) {
      this.differingHost.replaceChildren(
        toggle('Differing params only', this.st.s.differingOnly, (v) => {
          this.st.s.differingOnly = v;
          this.st.changed('table', 'toolbar');
        }, 'Show only parameter columns whose values differ between the filtered runs'),
      );
    }
    const total = this.st.allRuns().length;
    const shown = this.st.filteredRuns().length;
    const sel = this.st.selectedRuns().length;
    this.counts.replaceChildren(
      h('b', {}, String(shown)),
      shown === total ? ' runs' : ` of ${total} runs`,
      h('span', { class: 'muted' }, '  ·  '),
      h('b', {}, String(sel)),
      ' selected',
    );
    const colConds = Object.entries(this.st.s.filters.columns).filter(([k, v]) => v.trim() && k !== 'location').length;
    this.setBadge(this.filterBtn, colConds);
    this.groupBtn.classList.toggle('active', !!this.st.s.groupBy);
    this.groupBtn.querySelector('.btn-label')!.textContent = this.st.s.groupBy ? `Group: ${this.shortLabel(this.st.s.groupBy)}` : 'Group';
    this.renderChips();
  }

  private setBadge(b: HTMLButtonElement, n: number): void {
    b.querySelector('.btn-badge')?.remove();
    b.classList.toggle('active', n > 0);
    if (n > 0) b.append(h('span', { class: 'btn-badge' }, String(n)));
  }

  private shortLabel(id: string): string {
    const c = this.st.availableColumns().find((x) => x.id === id);
    return c ? (c.kind === 'param' ? c.key : columnLabel(c)) : id;
  }

  private renderSegment(): void {
    const counts = new Map<DisplayStatus, number>();
    for (const r of this.st.allRuns()) counts.set(r.displayStatus, (counts.get(r.displayStatus) ?? 0) + 1);
    const active = new Set(this.st.s.filters.statuses);
    const key = JSON.stringify([[...counts], [...active]]);
    if (key === this.segKey) return;
    this.segKey = key;
    const seg = (label: string, s: DisplayStatus | null, n: number) => {
      const on = s === null ? active.size === 0 : active.has(s);
      const b = h(
        'button',
        { type: 'button', class: `seg${on ? ' active' : ''}`, 'aria-pressed': String(on), title: s ? `Show ${s} runs (click several to combine)` : 'Show all statuses' },
        s ? h('span', { class: `dot st-${s}`, 'aria-hidden': 'true' }) : null,
        label,
        h('span', { class: 'seg-count' }, String(n)),
      );
      b.addEventListener('click', () => {
        if (s === null) this.st.s.filters.statuses = [];
        else {
          const next = new Set(active);
          if (next.has(s)) next.delete(s);
          else next.add(s);
          this.st.s.filters.statuses = DISPLAY_STATUSES.filter((x) => next.has(x));
        }
        this.st.changed('table', 'toolbar', 'plots', 'nav');
      });
      return b;
    };
    this.segment.replaceChildren(
      seg('All', null, this.st.allRuns().length),
      ...SEGMENT.filter((s) => counts.has(s) || active.has(s)).map((s) => seg(s[0]!.toUpperCase() + s.slice(1), s, counts.get(s) ?? 0)),
    );
  }

  private renderChips(): void {
    const f = this.st.s.filters;
    const key = JSON.stringify([f, this.st.s.groupBy, this.st.s.differingOnly, this.st.availableColumns().length]);
    if (key === this.chipsKey) return;
    this.chipsKey = key;
    const cols = new Map(this.st.availableColumns().map((c) => [c.id, c]));
    const chips: HTMLElement[] = [];
    const update = () => this.st.changed('table', 'toolbar', 'plots', 'nav');
    const kv = (k: string, v: string) => h('span', {}, h('span', { class: 'chip-key' }, `${k}: `), v);
    if (f.search.trim()) chips.push(chip(kv('search', f.search), () => this.setSearch('')));
    for (const s of f.statuses)
      chips.push(
        chip(kv('status', s), () => {
          f.statuses = f.statuses.filter((x) => x !== s);
          update();
        }),
      );
    for (const [id, expr] of Object.entries(f.columns)) {
      if (!expr.trim()) continue;
      const c = cols.get(id);
      const isRoot = id === 'location' && expr.startsWith('/^');
      const label = isRoot ? 'run root' : c ? columnLabel(c) : id;
      const shown = isRoot ? expr.slice(2, -3).replace(/\\(.)/g, '$1') : expr;
      const invalid = parseColumnFilter(expr).error;
      const el = chip(
        kv(label, shown),
        () => {
          delete f.columns[id];
          update();
        },
        { title: invalid ? `Ignored: ${invalid}` : `${label} ${expr}` },
      );
      if (invalid) el.classList.add('invalid');
      chips.push(el);
    }
    if (this.st.s.groupBy)
      chips.push(
        chip(kv('grouped by', this.shortLabel(this.st.s.groupBy)), () => {
          this.st.s.groupBy = null;
          this.st.changed('table', 'toolbar', 'plots');
        }),
      );
    if (this.st.s.differingOnly)
      chips.push(
        chip('differing params only', () => {
          this.st.s.differingOnly = false;
          this.st.changed('table', 'toolbar');
        }),
      );
    this.chips.replaceChildren(...chips);
    if (chips.length)
      this.chips.append(
        button({
          label: 'Clear all',
          variant: 'ghost',
          cls: 'btn-small',
          onClick: () => {
            this.st.s.groupBy = null;
            this.st.s.differingOnly = false;
            this.search.value = '';
            this.st.clearFilters();
          },
        }),
      );
    this.chips.hidden = chips.length === 0;
  }

  // -- popovers ----------------------------------------------------------------------

  private openFilter(): void {
    const f = this.st.s.filters;
    const cols = this.st.availableColumns().filter((c) => c.id !== 'status');
    const body = h('div', { class: 'pop-body filter-pop' });
    const render = () => {
      const conds = Object.entries(f.columns).filter(([id, v]) => v.trim() && id !== 'location');
      const colSel = h('select', { 'aria-label': 'Field' }, ...fieldOptions(cols, null));
      const expr = h('input', { type: 'text', placeholder: '> 0.8   0.1..0.5   text   /regex/', 'aria-label': 'Condition', spellcheck: 'false' });
      const err = h('div', { class: 'field-error', role: 'alert' });
      const add = () => {
        if (!expr.value.trim()) return;
        const e = parseColumnFilter(expr.value);
        if (e.error) {
          err.textContent = e.error;
          return;
        }
        f.columns[colSel.value] = expr.value.trim();
        this.st.changed('table', 'toolbar', 'plots');
        render();
        body.querySelector<HTMLInputElement>('.cond-add input')?.focus();
      };
      expr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') add();
      });
      body.replaceChildren(
        h('div', { class: 'pop-title' }, 'Conditions'),
        conds.length
          ? h(
              'div',
              { class: 'cond-list' },
              ...conds.map(([id, v]) => {
                const c = cols.find((x) => x.id === id);
                const rm = button({
                  icon: 'close',
                  title: 'Remove condition',
                  variant: 'ghost',
                  onClick: () => {
                    delete f.columns[id];
                    this.st.changed('table', 'toolbar', 'plots');
                    render();
                  },
                });
                return h('div', { class: 'cond' }, h('span', { class: 'cond-field' }, c ? columnLabel(c) : id), h('code', { class: 'cond-expr' }, v), rm);
              }),
            )
          : h('div', { class: 'muted pop-note' }, 'No column conditions yet.'),
        h('div', { class: 'cond-add' }, colSel, expr, button({ label: 'Add', icon: 'plus', variant: 'primary', onClick: add })),
        err,
        h('div', { class: 'pop-help muted' }, 'Numbers: > 0.8 · <= 1e-3 · 0.1..0.5 · = 64 · != 0   Text: substring or /regex/'),
        h('div', { class: 'pop-sep' }),
        toggle('Show filter inputs under column headers', this.st.s.showFilterRow, (v) => {
          this.st.s.showFilterRow = v;
          this.st.changed('table');
        }),
      );
    };
    render();
    openPopover(this.filterBtn, body, { width: 440, label: 'Filter conditions' });
  }

  private openGroup(): void {
    const cur = this.st.s.groupBy;
    const set = (v: string | null) => {
      this.st.s.groupBy = v;
      this.st.s.collapsedGroups = [];
      this.st.changed('table', 'plots', 'toolbar');
    };
    const items: Parameters<typeof menu>[0] = [{ label: 'No grouping', checked: cur === null, onSelect: () => set(null) }, 'separator'];
    const byKind = new Map<string, ColumnDef[]>();
    for (const c of this.st.groupFields()) byKind.set(KIND_TITLES[c.kind], [...(byKind.get(KIND_TITLES[c.kind]) ?? []), c]);
    for (const [title, cols] of byKind) {
      items.push({ header: title });
      for (const c of cols) items.push({ label: c.kind === 'param' ? c.key : columnLabel(c), checked: cur === c.id, onSelect: () => set(c.id) });
    }
    openPopover(this.groupBtn, h('div', { class: 'menu-scroll' }, menu(items)), { label: 'Group by', width: 260 });
  }

  private openColumns(): void {
    const body = h('div', { class: 'pop-body chooser' });
    const render = () => {
      const visible = new Set(this.st.visibleColumns().map((c) => c.id));
      const filterInput = h('input', { type: 'search', placeholder: 'Filter columns…', value: this.chooserFilter, spellcheck: 'false', 'aria-label': 'Filter columns' });
      filterInput.addEventListener('input', () => {
        this.chooserFilter = filterInput.value;
        render();
        const again = body.querySelector<HTMLInputElement>('input[type=search]');
        again?.focus();
        again?.setSelectionRange(again.value.length, again.value.length);
      });
      const needle = this.chooserFilter.toLowerCase();
      const groups = new Map<string, ColumnDef[]>();
      for (const c of this.st.availableColumns()) {
        if (needle && !c.label.toLowerCase().includes(needle)) continue;
        groups.set(KIND_TITLES[c.kind], [...(groups.get(KIND_TITLES[c.kind]) ?? []), c]);
      }
      body.replaceChildren(
        h(
          'div',
          { class: 'chooser-head' },
          filterInput,
          button({
            label: 'Reset',
            variant: 'ghost',
            title: 'Reset to default columns',
            onClick: () => {
              this.st.s.visibleColumns = null;
              this.st.changed('table');
              render();
            },
          }),
        ),
        h(
          'div',
          { class: 'chooser-body' },
          ...[...groups].map(([title, cols]) =>
            h(
              'section',
              {},
              h('div', { class: 'menu-header' }, title),
              h(
                'div',
                { class: 'chooser-grid' },
                ...cols.map((c) => {
                  const cb = h('input', { type: 'checkbox', checked: visible.has(c.id) });
                  cb.addEventListener('change', () => this.setColumnVisible(c.id, cb.checked));
                  return h('label', { class: 'check', title: c.label }, cb, h('span', {}, c.kind === 'last' || c.kind === 'best' ? c.key : c.label));
                }),
              ),
            ),
          ),
        ),
      );
    };
    render();
    openPopover(this.columnsBtn, body, { width: 540, align: 'right', label: 'Columns' });
  }

  private openMore(anchor: HTMLButtonElement): void {
    const st = this.st;
    const grouped = !!st.s.groupBy;
    openPopover(
      anchor,
      menu([
        { label: 'Select filtered runs', icon: 'check', onSelect: () => st.setSelected([...selectFiltered(new Set(st.s.selected), st.sortedRuns())]) },
        { label: 'Clear selection', icon: 'close', disabled: st.s.selected.length === 0, onSelect: () => st.setSelected([]) },
        'separator',
        { label: 'Clear filters', icon: 'filter', disabled: st.activeFilterCount() === 0, onSelect: () => st.clearFilters() },
        {
          label: st.s.showFilterRow ? 'Hide column filter inputs' : 'Show column filter inputs',
          icon: 'columns',
          onSelect: () => {
            st.s.showFilterRow = !st.s.showFilterRow;
            st.changed('table');
          },
        },
        'separator',
        {
          label: 'Collapse all groups',
          disabled: !grouped,
          onSelect: () => {
            st.s.collapsedGroups = (st.tableGroups() ?? []).map((g) => g.label);
            st.changed('table');
          },
        },
        {
          label: 'Expand all groups',
          disabled: !grouped || st.s.collapsedGroups.length === 0,
          onSelect: () => {
            st.s.collapsedGroups = [];
            st.changed('table');
          },
        },
        'separator',
        {
          label: 'Reset columns',
          icon: 'refresh',
          onSelect: () => {
            st.s.visibleColumns = null;
            st.changed('table');
          },
        },
      ]),
      { align: 'right', label: 'More actions', width: 250 },
    );
  }

  private setColumnVisible(id: string, on: boolean): void {
    const current = this.st.s.visibleColumns ?? this.st.visibleColumns().map((c) => c.id);
    const next = current.filter((c) => c !== id);
    if (on) next.push(id);
    this.st.s.visibleColumns = next.length ? next : defaultVisibleColumns(this.st.filteredRuns());
    this.st.changed('table');
  }
}
