// Small UI primitives shared by all views: icons, buttons, chips, switches, popovers, empty states.
import type { DisplayStatus } from '../types';
import { esc, h } from './dom';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Restrained line icons (24x24 viewBox, stroked with currentColor). */
const ICONS: Record<string, string> = {
  overview: 'M3 3h7v9H3z M14 3h7v5h-7z M14 12h7v9h-7z M3 16h7v5H3z',
  runs: 'M4 6h16 M4 12h16 M4 18h16',
  compare: 'M12 3v18 M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  settings: 'M4 21v-7 M4 10V3 M12 21v-9 M12 8V3 M20 21v-5 M20 12V3 M1 14h6 M9 8h6 M17 16h6',
  refresh: 'M21 12a9 9 0 1 1-2.64-6.36 M21 3v6h-6',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M21 21l-4.35-4.35',
  filter: 'M3 4h18l-7 8v6l-4 2v-8z',
  columns: 'M3 4h18v16H3z M9 4v16 M15 4v16',
  group: 'M12 3l9 5-9 5-9-5z M3 13l9 5 9-5',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  close: 'M18 6L6 18 M6 6l12 12',
  chevronLeft: 'M15 18l-6-6 6-6',
  chevronRight: 'M9 18l6-6-6-6',
  chevronDown: 'M6 9l6 6 6-6',
  warning: 'M12 3l10 18H2z M12 10v4 M12 17h.01',
  check: 'M5 12l5 5 9-10',
  plus: 'M12 5v14 M5 12h14',
  file: 'M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z M14 3v6h6',
  chart: 'M3 3v18h18 M7 15l4-4 3 3 5-6',
  scatter: 'M3 3v18h18 M8 15h.01 M12 10h.01 M16 13h.01 M18 7h.01 M10 17h.01',
  box: 'M3 3v18h18 M7 8v8 M7 11h3v4H7 M14 5v11 M12 8h4v5h-4',
  arrowUp: 'M12 19V5 M6 11l6-6 6 6',
  arrowDown: 'M12 5v14 M6 13l6 6 6-6',
  selected: 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z M8 12l3 3 5-6',
  inbox: 'M22 12h-6l-2 3h-4l-2-3H2 M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z',
  activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
};

export function icon(name: keyof typeof ICONS | string, size = 16): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', name === 'more' ? '3' : '1.75');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[name] ?? '');
  svg.append(path);
  return svg;
}

/** Icon as an HTML string (for innerHTML-rendered table rows). */
export function iconHtml(name: string, size = 14): string {
  return `<svg class="icon" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[name] ?? ''}"/></svg>`;
}

export type ButtonVariant = 'primary' | 'secondary' | 'ghost';

export function button(opts: {
  label?: string;
  icon?: string;
  title?: string;
  variant?: ButtonVariant;
  onClick?: (e: MouseEvent) => void;
  cls?: string;
  badge?: string | number | null;
}): HTMLButtonElement {
  const b = h('button', {
    type: 'button',
    class: `btn btn-${opts.variant ?? 'secondary'}${opts.label ? '' : ' btn-icon'}${opts.cls ? ` ${opts.cls}` : ''}`,
    title: opts.title ?? opts.label ?? '',
    'aria-label': opts.label ? null : (opts.title ?? null),
  });
  if (opts.icon) b.append(icon(opts.icon, 15));
  if (opts.label) b.append(h('span', { class: 'btn-label' }, opts.label));
  if (opts.badge !== undefined && opts.badge !== null && opts.badge !== 0 && opts.badge !== '') b.append(h('span', { class: 'btn-badge' }, String(opts.badge)));
  if (opts.onClick) b.addEventListener('click', (e) => opts.onClick!(e));
  return b;
}

/** Accessible toggle switch (a checkbox with role=switch). */
export function toggle(label: string, checked: boolean, onChange: (v: boolean) => void, title = ''): HTMLLabelElement {
  const input = h('input', { type: 'checkbox', role: 'switch', checked, class: 'switch-input' });
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'switch', title }, input, h('span', { class: 'switch-track', 'aria-hidden': 'true' }), h('span', {}, label));
}

/** Removable chip (active filters, selected metrics). */
export function chip(label: Node | string, onRemove: (() => void) | null, opts: { title?: string; color?: string } = {}): HTMLElement {
  const el = h('span', { class: 'chip', title: opts.title ?? '' });
  if (opts.color) el.append(h('span', { class: 'swatch', style: `background:${opts.color}` }));
  el.append(h('span', { class: 'chip-label' }, label));
  if (onRemove) {
    const x = h('button', { type: 'button', class: 'chip-remove', 'aria-label': `Remove ${typeof label === 'string' ? label : 'filter'}`, title: 'Remove' }, icon('close', 12));
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      onRemove();
    });
    el.append(x);
  }
  return el;
}

export const STATUS_LABEL: Record<DisplayStatus, string> = {
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  killed: 'killed',
  stale: 'stale',
  unknown: 'unknown',
};

/** Status pill: coloured dot + text (never colour alone). */
export function statusHtml(status: DisplayStatus, suffix = '', title: string = status): string {
  return `<span class="status st-${status}" title="${esc(title)}"><span class="dot" aria-hidden="true"></span>${STATUS_LABEL[status]}${suffix}</span>`;
}

export function statusEl(status: DisplayStatus, suffix = '', title?: string): HTMLElement {
  const wrap = h('span', {});
  wrap.innerHTML = statusHtml(status, suffix, title);
  return wrap.firstElementChild as HTMLElement;
}

export function emptyState(opts: { icon?: string; title: string; text?: string; action?: { label: string; onClick: () => void; icon?: string }; compact?: boolean; busy?: boolean }): HTMLElement {
  const el = h('div', { class: `empty-state${opts.compact ? ' compact' : ''}`, role: 'status' });
  if (opts.busy) el.append(h('span', { class: 'spinner', 'aria-hidden': 'true' }));
  else if (opts.icon) el.append(h('span', { class: 'empty-icon' }, icon(opts.icon, 22)));
  el.append(h('div', { class: 'empty-title' }, opts.title));
  if (opts.text) el.append(h('div', { class: 'empty-text' }, opts.text));
  if (opts.action) el.append(button({ label: opts.action.label, icon: opts.action.icon, variant: 'secondary', onClick: opts.action.onClick }));
  return el;
}

// ---------------------------------------------------------------------------
// Popovers / menus
// ---------------------------------------------------------------------------

let openPop: { el: HTMLElement; anchor: HTMLElement; close: () => void } | null = null;

export function closePopover(): void {
  openPop?.close();
}

export function isPopoverOpenFor(anchor: HTMLElement): boolean {
  return openPop?.anchor === anchor;
}

/**
 * Opens a floating panel under `anchor`. Only one popover is open at a time; it closes on
 * outside click, Escape, or when the same anchor is clicked again.
 */
export function openPopover(anchor: HTMLElement, content: HTMLElement, opts: { align?: 'left' | 'right'; width?: number; label?: string; onClose?: () => void } = {}): () => void {
  if (openPop?.anchor === anchor) {
    openPop.close();
    return () => {};
  }
  openPop?.close();
  const el = h('div', { class: 'popover', role: 'dialog', 'aria-label': opts.label ?? '' }, content);
  if (opts.width) el.style.width = `${opts.width}px`;
  document.body.append(el);
  const place = () => {
    const r = anchor.getBoundingClientRect();
    const w = el.offsetWidth;
    let left = opts.align === 'right' ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = r.bottom + 6;
    if (top + el.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - el.offsetHeight - 6);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  };
  place();
  anchor.setAttribute('aria-expanded', 'true');
  const onDoc = (e: MouseEvent) => {
    const t = e.target as Node;
    if (!el.contains(t) && !anchor.contains(t) && t.isConnected) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      close();
      anchor.focus();
    }
  };
  const close = () => {
    el.remove();
    anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', onDoc, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', place);
    if (openPop?.el === el) openPop = null;
    opts.onClose?.();
  };
  document.addEventListener('mousedown', onDoc, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', place);
  openPop = { el, anchor, close };
  // focus the first control for keyboard users
  el.querySelector<HTMLElement>('input, select, button')?.focus();
  return close;
}

export interface MenuItem {
  label: string;
  icon?: string;
  checked?: boolean;
  disabled?: boolean;
  hint?: string;
  onSelect: () => void;
}

/** Vertical menu (for "More", "Group by"...). Arrow keys move focus. */
export function menu(items: (MenuItem | 'separator' | { header: string })[]): HTMLElement {
  const el = h('div', { class: 'menu', role: 'menu' });
  for (const it of items) {
    if (it === 'separator') {
      el.append(h('div', { class: 'menu-sep', role: 'separator' }));
      continue;
    }
    if ('header' in it) {
      el.append(h('div', { class: 'menu-header' }, it.header));
      continue;
    }
    const b = h(
      'button',
      { type: 'button', class: `menu-item${it.checked ? ' checked' : ''}`, role: it.checked === undefined ? 'menuitem' : 'menuitemradio', 'aria-checked': it.checked === undefined ? null : String(it.checked), disabled: it.disabled },
      h('span', { class: 'menu-check' }, it.checked ? icon('check', 14) : it.icon ? icon(it.icon, 14) : ''),
      h('span', { class: 'menu-label' }, it.label),
      it.hint ? h('span', { class: 'menu-hint' }, it.hint) : null,
    );
    b.addEventListener('click', () => {
      closePopover();
      it.onSelect();
    });
    el.append(b);
  }
  el.addEventListener('keydown', (e) => {
    const items = [...el.querySelectorAll<HTMLButtonElement>('.menu-item:not(:disabled)')];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') items[(i + 1) % items.length]?.focus();
    else if (e.key === 'ArrowUp') items[(i - 1 + items.length) % items.length]?.focus();
    else return;
    e.preventDefault();
  });
  return el;
}
