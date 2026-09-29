// Tiny DOM + formatting helpers for the webview (no framework).
import type { Scalar } from '../types';

type Attrs = Record<string, string | number | boolean | null | undefined | ((e: Event) => void)>;
type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (typeof v === 'function') el.addEventListener(k.replace(/^on/, '').toLowerCase(), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k === 'value' && 'value' in el) (el as HTMLInputElement).value = String(v);
    else if (k === 'checked' && 'checked' in el) (el as HTMLInputElement).checked = Boolean(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

/** requestAnimationFrame with a timer fallback (rAF is paused in hidden/background webviews). */
export function nextFrame(fn: () => void): void {
  let done = false;
  const run = () => {
    if (done) return;
    done = true;
    fn();
  };
  requestAnimationFrame(run);
  setTimeout(run, 50);
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c]!);
}

export function formatNumber(v: number): string {
  if (!Number.isFinite(v)) return String(v);
  if (Number.isInteger(v) && Math.abs(v) < 1e7) return String(v);
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e7)) return Number(v.toPrecision(3)).toExponential().replace('e+', 'e');
  return String(Number(v.toPrecision(4)));
}

export function formatScalar(v: Scalar | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return formatNumber(v);
  return String(v);
}

const pad = (n: number) => String(n).padStart(2, '0');

export function formatTime(ms: number | null): string {
  if (ms === null) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatTimeFull(ms: number | null): string {
  if (ms === null) return '—';
  const d = new Date(ms);
  return `${formatTime(ms)}:${pad(d.getSeconds())}`;
}

export function formatDuration(s: number | null): string {
  if (s === null) return '';
  const t = Math.round(s);
  const d = Math.floor(t / 86400);
  const hh = Math.floor((t % 86400) / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  if (d) return `${d}d ${hh}h`;
  if (hh) return `${hh}h ${pad(m)}m`;
  if (m) return `${m}m ${pad(sec)}s`;
  return `${sec}s`;
}

/** Formats seconds as h:mm:ss for the wall-time axis. */
export function formatClock(s: number): string {
  const sign = s < 0 ? '-' : '';
  const t = Math.abs(Math.round(s));
  const hh = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = t % 60;
  return hh ? `${sign}${hh}:${pad(m)}:${pad(sec)}` : `${sign}${m}:${pad(sec)}`;
}

export function relativeAge(ms: number | null, now = Date.now()): string {
  if (ms === null) return '';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Categorical run palette from the TraceML dark tokens (--tm-series-0..9). */
let paletteCache: string[] | null = null;
export function palette(): string[] {
  if (paletteCache) return paletteCache;
  const cs = getComputedStyle(document.documentElement);
  const fallback = ['#5b9cf6', '#f2994a', '#4cc38a', '#ef6461', '#b28cf2', '#e8c547', '#3fc8d4', '#f07bb8', '#a3adbb', '#a3d65c'];
  paletteCache = fallback.map((f, i) => cs.getPropertyValue(`--tm-series-${i}`).trim() || f);
  return paletteCache;
}

export function withAlpha(color: string, a: number): string {
  const c = color.trim();
  let m = /^#([0-9a-f]{3,8})$/i.exec(c);
  if (m) {
    let hex = m[1]!;
    if (hex.length <= 4) hex = [...hex].map((x) => x + x).join('');
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    return `rgba(${r},${g},${b},${a})`;
  }
  m = /^rgba?\(([^)]+)\)$/i.exec(c);
  if (m) {
    const [r, g, b] = m[1]!.split(/[\s,/]+/);
    return `rgba(${r},${g},${b},${a})`;
  }
  return c;
}

/** Resolved value of a CSS custom property (design token). */
export function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.body).getPropertyValue(name).trim() || fallback;
}
