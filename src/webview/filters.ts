// Runs toolbar: search, Filter / Group / Columns / More, status segment, differing-params switch
// and removable chips for every active filter.
import { NUMERIC_OPS, TEXT_OPS, buildFilterExpr, defaultVisibleColumns, describeFilter, parseColumnFilter, selectFiltered, suggestValues, type FilterOp } from '../model/filters';
import type { ColumnDef } from '../model/run';
import { DISPLAY_STATUSES, type DisplayStatus } from '../types';
import { h } from './dom';
import { MAX_ROWS_LIMIT, parseMaxRows, type AppState, type Area } from './state';
import { button, chip, icon, menu, openPopover, toggle } from './ui';

/**
 * Section titles of the column kinds. Logged values form three groups: Config (params.yaml), Run
 * (metric history: start / last / best value) and Summary (final values).
 */
export const KIND_TITLES: Record<ColumnDef['kind'], string> = { fixed: 'Run info', param: 'Config', first: 'Run · start value', last: 'Run · last value', best: 'Run · best value', summary: 'Summary' };

/** Human label of a column for chips / menus. */
export function columnLabel(c: ColumnDef): string {
  if (c.kind === 'last' || c.kind === 'best') return `${c.kind} ${c.key}`;
  return c.label;
}

/** Popover listing the runs deleted from TraceML, with Restore actions. */
export function openHiddenRuns(st: AppState, anchor: HTMLElement): void {
  const body = h('div', { class: 'pop-body hidden-pop' });
  const render = () => {
    const runs = st.hiddenRuns;
    body.replaceChildren(
      h('div', { class: 'pop-title' }, `Deleted from TraceML (${runs.length})`),
      h('div', { class: 'muted pop-note' }, 'These runs are hidden in TraceML. Their folders and files were not touched. Restore a run to show it again.'),
      runs.length
        ? h(
            'div',
            { class: 'hidden-list' },
            ...runs.map((r) =>
              h(
                'div',
                { class: 'hidden-item' },
                h('div', { class: 'hidden-name', title: `${r.id}\n${r.location}\ndeleted ${r.hiddenAt}` }, h('b', {}, r.name), h('span', { class: 'muted small' }, r.location)),
                button({
                  label: 'Restore',
                  variant: 'ghost',
                  cls: 'btn-small',
                  onClick: () => {
                    st.unhideRuns([r.key]);
                    st.hiddenRuns = st.hiddenRuns.filter((x) => x.key !== r.key);
                    render();
                  },
                }),
              ),
            ),
          )
        : h('div', { class: 'muted pop-note' }, 'No deleted runs.'),
      runs.length > 1
        ? h(
            'div',
            { class: 'pop-actions' },
            button({
              label: 'Restore all',
              variant: 'secondary',
              onClick: () => {
                st.unhideRuns(st.hiddenRuns.map((r) => r.key));
                st.hiddenRuns = [];
                render();
              },
            }),
          )
        : '',
    );
  };
  render();
  openPopover(anchor, body, { width: 380, align: 'right', label: 'Deleted runs' });
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

/** Choices for the Max rows control (null = all rows). */
export const MAX_ROW_OPTIONS: (number | null)[] = [25, 50, 100, 250, 500, 1000, null];

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
  private readonly maxRows: HTMLInputElement;
  private readonly firstHost = h('span', {});
  private readonly exportBtn: HTMLButtonElement;
  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  private segKey = '';
  private chipsKey = '';
  private chooserFilter = '';
  /** Field last used in the filter builder. */
  private filterField: string | null = null;

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
    this.exportBtn = button({
      label: 'Export',
      icon: 'file',
      title: 'Save the rows shown in the table (filters, sort, column order and Max rows applied) as a CSV file an agent or pandas can read',
      onClick: () => st.exportTable(),
    });
    // Max rows: pick a preset or type any whole number up to MAX_ROWS_LIMIT ("All" = no limit).
    const maxRowsHelp = `Maximum number of rows shown in the table (applied after filters and sorting). Type any number from 1 to ${MAX_ROWS_LIMIT}, or All.`;
    this.maxRows = h('input', {
      type: 'text',
      class: 'max-rows-input',
      inputmode: 'numeric',
      list: 'traceml-max-rows',
      'aria-label': 'Max rows',
      title: maxRowsHelp,
      spellcheck: 'false',
      value: st.s.maxRows === null ? 'All' : String(st.s.maxRows),
    });
    const maxRowsList = h('datalist', { id: 'traceml-max-rows' }, ...MAX_ROW_OPTIONS.map((n) => h('option', { value: n === null ? 'All' : String(n) })));
    let maxRowsTimer: ReturnType<typeof setTimeout> | undefined;
    const applyMaxRows = (commit: boolean) => {
      const v = parseMaxRows(this.maxRows.value);
      this.maxRows.classList.toggle('invalid', v === undefined);
      this.maxRows.title = v === undefined ? `Enter a whole number from 1 to ${MAX_ROWS_LIMIT}, or All` : maxRowsHelp;
      if (v === undefined) {
        if (commit) this.maxRows.value = st.s.maxRows === null ? 'All' : String(st.s.maxRows);
        if (commit) this.maxRows.classList.remove('invalid');
        return;
      }
      if (commit) this.maxRows.value = v === null ? 'All' : String(v);
      if (v === st.s.maxRows) return;
      st.s.maxRows = v;
      st.changed('table', 'toolbar');
    };
    this.maxRows.addEventListener('input', () => {
      clearTimeout(maxRowsTimer);
      maxRowsTimer = setTimeout(() => applyMaxRows(false), 250);
    });
    this.maxRows.addEventListener('change', () => applyMaxRows(true));
    this.maxRows.addEventListener('focus', () => this.maxRows.select());
    this.maxRows.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') applyMaxRows(true);
    });
    for (const b of [this.filterBtn, this.groupBtn, this.columnsBtn, moreBtn]) b.setAttribute('aria-haspopup', 'true');

    const primary = h(
      'div',
      { class: 'toolbar-row' },
      h('div', { class: 'search' }, icon('search', 15), this.search, this.searchClear),
      h('div', { class: 'spacer' }),
      h('div', { class: 'btn-group' }, this.filterBtn, this.groupBtn, this.columnsBtn, this.exportBtn, moreBtn),
    );
    const secondary = h(
      'div',
      { class: 'toolbar-row' },
      this.segment,
      this.differingHost,
      this.firstHost,
      h(
        'div',
        { class: 'toolbar-right' },
        this.counts,
        h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Max rows'), this.maxRows, maxRowsList),
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
    this.exportBtn.classList.toggle('busy', this.st.exporting);
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
    if (!this.firstHost.firstChild || (this.firstHost.querySelector('input') as HTMLInputElement).checked !== this.st.s.showFirst) {
      this.firstHost.replaceChildren(
        toggle('Starting values', this.st.s.showFirst, (v) => this.st.setShowFirst(v), 'Also show each metric\'s starting value (its first logged value in metrics.jsonl) in the table, charts and comparison'),
      );
    }
    if (document.activeElement !== this.maxRows) {
      const shown = this.st.s.maxRows === null ? 'All' : String(this.st.s.maxRows);
      if (this.maxRows.value !== shown) this.maxRows.value = shown;
    }
    const total = this.st.allRuns().length;
    const filtered = this.st.filteredRuns().length;
    const displayed = this.st.displayedRuns().length;
    const sel = this.st.selectedRuns().length;
    this.counts.replaceChildren(
      ...(displayed < filtered ? ['showing ', h('b', {}, String(displayed)), ' of '] : []),
      h('b', {}, String(filtered)),
      filtered === total ? ' runs' : ` filtered of ${total}`,
      h('span', { class: 'muted' }, '  ·  '),
      h('b', {}, String(sel)),
      ' selected',
    );
    this.counts.title = displayed < filtered ? `The table shows the first ${displayed} rows (Max rows). Increase Max rows to see more.` : '';
    this.exportBtn.disabled = displayed === 0;
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
      const shown = isRoot ? expr.slice(2, -3).replace(/\\(.)/g, '$1') : describeFilter(expr);
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
      // Builder: field -> operator -> value (with suggestions from the runs' own values).
      const colSel = h('select', { 'aria-label': 'Field' }, ...fieldOptions(cols, this.filterField));
      const opSel = h('select', { 'aria-label': 'Operator', class: 'cond-op' });
      const suggest = h('datalist', { id: 'traceml-filter-values' });
      const expr = h('input', { type: 'text', list: 'traceml-filter-values', 'aria-label': 'Value', spellcheck: 'false', autocomplete: 'off' });
      const err = h('div', { class: 'field-error', role: 'alert' });
      const syncField = () => {
        this.filterField = colSel.value;
        const col = cols.find((c) => c.id === colSel.value);
        const ops = col?.numeric ? NUMERIC_OPS : TEXT_OPS;
        // Keep the chosen operator while the field type stays the same; otherwise use the type's default.
        const prev = opSel.value as FilterOp;
        const sameKind = opSel.dataset.numeric === String(!!col?.numeric);
        opSel.dataset.numeric = String(!!col?.numeric);
        opSel.replaceChildren(...ops.map((o) => h('option', { value: o }, o)));
        opSel.value = sameKind && ops.includes(prev) ? prev : col?.numeric ? '>' : 'contains';
        suggest.replaceChildren(...suggestValues(this.st.allRuns(), colSel.value).map((v) => h('option', { value: v })));
        syncOp();
      };
      const syncOp = () => {
        const op = opSel.value as FilterOp;
        expr.placeholder = op === 'between' ? 'e.g. 0.1..0.5' : op === 'regex' ? 'e.g. ^adam' : 'type or pick a value';
        err.textContent = '';
      };
      colSel.addEventListener('change', syncField);
      opSel.addEventListener('change', syncOp);
      const add = () => {
        if (!expr.value.trim()) {
          err.textContent = 'Enter a value';
          return;
        }
        const built = buildFilterExpr(opSel.value as FilterOp, expr.value);
        const e = parseColumnFilter(built);
        if (e.error) {
          err.textContent = e.error;
          return;
        }
        f.columns[colSel.value] = built;
        this.st.changed('table', 'toolbar', 'plots');
        render();
        body.querySelector<HTMLInputElement>('.cond-add input')?.focus();
      };
      expr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') add();
      });
      syncField();
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
                return h('div', { class: 'cond' }, h('span', { class: 'cond-field' }, c ? columnLabel(c) : id), h('code', { class: 'cond-expr', title: v }, describeFilter(v)), rm);
              }),
            )
          : h('div', { class: 'muted pop-note' }, 'No column conditions yet.'),
        h('div', { class: 'cond-add' }, colSel, opSel, expr, suggest, button({ label: 'Add', icon: 'plus', variant: 'primary', onClick: add })),
        err,
        h('div', { class: 'pop-help muted' }, 'Suggestions come from the values in your runs. Text matching ignores case; runs without a value never match. In the column filter inputs you can also type: > 0.8 · 0.1..0.5 · = adamw · != adamw · ~ adam (contains) · !~ adam (not contains) · /regex/'),
        h('div', { class: 'pop-sep' }),
        toggle('Show filter inputs under column headers', this.st.s.showFilterRow, (v) => {
          this.st.s.showFilterRow = v;
          this.st.changed('table');
        }),
      );
    };
    render();
    openPopover(this.filterBtn, body, { width: 560, label: 'Filter conditions' });
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
                  return h('label', { class: 'check', title: c.label }, cb, h('span', {}, c.kind === 'first' || c.kind === 'last' || c.kind === 'best' ? c.key : c.label));
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
        {
          label: st.s.selected.length ? `Delete ${st.s.selected.length} selected from TraceML` : 'Delete selected from TraceML',
          icon: 'trash',
          disabled: st.s.selected.length === 0,
          onSelect: () => st.hideRuns([...st.s.selected]),
        },
        { label: `Deleted runs (${st.hiddenRuns.length})…`, icon: 'refresh', disabled: st.hiddenRuns.length === 0, onSelect: () => openHiddenRuns(st, anchor) },
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
