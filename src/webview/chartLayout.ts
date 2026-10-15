// Chart size and position, set from the "⋯" menu of every chart (line, scatter, box, bar). Sizes
// are remembered per chart id (`line:<metric>`, `scatter:<field>`...); positions are the order of
// the charted metrics / fields, so moving a chart reorders them.
import type { AppState } from './state';
import { button, menu, openPopover, type MenuItem } from './ui';

export type ChartWidth = 'small' | 'medium' | 'large' | 'full';
export type ChartHeight = 'compact' | 'normal' | 'tall' | 'xtall';
export interface ChartSize {
  w: ChartWidth;
  h: ChartHeight;
}

const WIDTHS: { id: ChartWidth; label: string; hint: string }[] = [
  { id: 'small', label: 'Small', hint: '⅓ row' },
  { id: 'medium', label: 'Medium', hint: '½ row' },
  { id: 'large', label: 'Large', hint: '⅔ row' },
  { id: 'full', label: 'Full width', hint: '' },
];

const HEIGHTS: { id: ChartHeight; label: string; scale: number }[] = [
  { id: 'compact', label: 'Compact', scale: 0.7 },
  { id: 'normal', label: 'Normal', scale: 1 },
  { id: 'tall', label: 'Tall', scale: 1.5 },
  { id: 'xtall', label: 'Extra tall', scale: 2 },
];

/** The saved size of a chart; unknown or missing values fall back to `defaults`. */
export function chartSize(st: AppState, id: string, defaults: ChartSize): ChartSize {
  const saved = st.s.chartSizes?.[id];
  return {
    w: WIDTHS.some((x) => x.id === saved?.w) ? saved!.w : defaults.w,
    h: HEIGHTS.some((x) => x.id === saved?.h) ? saved!.h : defaults.h,
  };
}

/** Height multiplier of a size (1 = the chart's normal height). */
export function heightScale(h: ChartHeight): number {
  return HEIGHTS.find((x) => x.id === h)?.scale ?? 1;
}

/** Sets the grid span (CSS, from `data-w`) of a chart element. */
export function applyWidth(el: HTMLElement, size: ChartSize): void {
  if (el.dataset.w !== size.w) el.dataset.w = size.w;
}

function saveSize(st: AppState, id: string, size: ChartSize | null): void {
  const next = { ...(st.s.chartSizes ?? {}) };
  if (size) next[id] = size;
  else delete next[id];
  st.s.chartSizes = next;
  st.changed('plots');
}

/**
 * The "⋯" button of a chart: width, height, move (first / earlier / later / last) and reset.
 * `position` is read when the menu opens; `onMove` gets the new index.
 */
export function chartMenuButton(opts: {
  st: AppState;
  id: string;
  name: string;
  defaults: ChartSize;
  position: () => { index: number; count: number };
  onMove: (to: number) => void;
}): HTMLButtonElement {
  const { st, id, defaults } = opts;
  const b: HTMLButtonElement = button({
    icon: 'more',
    title: `Size and position of ${opts.name}`,
    variant: 'ghost',
    cls: 'chart-menu',
    onClick: () => {
      const size = chartSize(st, id, defaults);
      const { index, count } = opts.position();
      const set = (patch: Partial<ChartSize>) => saveSize(st, id, { ...size, ...patch });
      const items: (MenuItem | 'separator' | { header: string })[] = [
        { header: 'Width' },
        ...WIDTHS.map((x): MenuItem => ({ label: x.label, hint: x.hint, checked: size.w === x.id, onSelect: () => set({ w: x.id }) })),
        { header: 'Height' },
        ...HEIGHTS.map((x): MenuItem => ({ label: x.label, checked: size.h === x.id, onSelect: () => set({ h: x.id }) })),
        'separator',
        { header: 'Position' },
        { label: 'Move to first', icon: 'arrowUp', disabled: index <= 0, onSelect: () => opts.onMove(0) },
        { label: 'Move earlier', icon: 'chevronLeft', disabled: index <= 0, onSelect: () => opts.onMove(index - 1) },
        { label: 'Move later', icon: 'chevronRight', disabled: index < 0 || index >= count - 1, onSelect: () => opts.onMove(index + 1) },
        { label: 'Move to last', icon: 'arrowDown', disabled: index < 0 || index >= count - 1, onSelect: () => opts.onMove(count - 1) },
        'separator',
        { label: 'Reset size', icon: 'refresh', disabled: size.w === defaults.w && size.h === defaults.h, onSelect: () => saveSize(st, id, null) },
      ];
      openPopover(b, menu(items), { align: 'right', width: 220, label: `${opts.name}: size and position` });
    },
  });
  b.setAttribute('aria-haspopup', 'true');
  return b;
}

/** `list` with the item at `from` moved to `to`. */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (from < 0 || from >= out.length) return out;
  const [x] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(out.length, to)), 0, x as T);
  return out;
}
