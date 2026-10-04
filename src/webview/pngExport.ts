// Chart export as 300 DPI PNG. Charts are re-rendered at 300/96 scale (uPlot charts are redrawn
// off-screen with scaled fonts and strokes; SVG charts are rasterized as vectors), then composed with
// a title and the legend onto one canvas. The host checks the PNG and writes the 300 DPI metadata.
import { cssVar } from './dom';

/** 300 DPI relative to the 96 DPI CSS pixel. */
export const EXPORT_SCALE = 300 / 96;

export interface LegendEntry {
  color: string;
  label: string;
}

export interface ComposeOptions {
  title: string;
  subtitle?: string;
  /** Chart image at EXPORT_SCALE resolution and its size in CSS pixels. */
  chart: CanvasImageSource;
  width: number;
  height: number;
  legend: LegendEntry[];
}

const PAD = 16;
const FONT = () => cssVar('--tm-font', 'sans-serif');

/** Composes title, chart and legend; returns the PNG as base64 (no data: prefix). */
export function composePng(o: ComposeOptions): string {
  const S = EXPORT_SCALE;
  const bg = cssVar('--tm-bg', '') || getComputedStyle(document.body).backgroundColor || '#ffffff';
  const fg = cssVar('--tm-text', '#222222');
  const muted = cssVar('--tm-text-secondary', '#666666');
  const measure = document.createElement('canvas').getContext('2d')!;

  // legend layout (CSS px), wrapping to the chart width
  measure.font = `11px ${FONT()}`;
  const rows: { x: number; e: LegendEntry }[][] = [];
  let row: { x: number; e: LegendEntry }[] = [];
  let x = 0;
  for (const e of o.legend) {
    const w = 14 + measure.measureText(e.label).width;
    if (row.length && x + w > o.width) {
      rows.push(row);
      row = [];
      x = 0;
    }
    row.push({ x, e });
    x += w + 16;
  }
  if (row.length) rows.push(row);

  const titleH = 20 + (o.subtitle ? 16 : 0);
  const legendH = rows.length ? 8 + rows.length * 18 : 0;
  const W = o.width + PAD * 2;
  const H = PAD + titleH + o.height + legendH + PAD;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(W * S);
  canvas.height = Math.round(H * S);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(S, S);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  ctx.textBaseline = 'top';
  ctx.fillStyle = fg;
  ctx.font = `600 14px ${FONT()}`;
  ctx.fillText(o.title, PAD, PAD);
  if (o.subtitle) {
    ctx.fillStyle = muted;
    ctx.font = `11px ${FONT()}`;
    ctx.fillText(o.subtitle, PAD, PAD + 20);
  }
  const chartTop = PAD + titleH;
  ctx.drawImage(o.chart, PAD, chartTop, o.width, o.height);

  ctx.font = `11px ${FONT()}`;
  ctx.textBaseline = 'middle';
  rows.forEach((r, i) => {
    const y = chartTop + o.height + 8 + i * 18 + 9;
    for (const { x: lx, e } of r) {
      ctx.fillStyle = e.color;
      ctx.fillRect(PAD + lx, y - 4, 9, 9);
      ctx.fillStyle = fg;
      ctx.fillText(e.label, PAD + lx + 14, y + 0.5);
    }
  });
  return canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
}

const STYLE_PROPS = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'opacity', 'font-size', 'font-weight', 'font-family', 'text-anchor', 'dominant-baseline', 'visibility', 'display'];

/**
 * Rasterizes an on-screen SVG chart at EXPORT_SCALE. Computed styles are inlined so the image looks
 * the same as the chart outside the page's stylesheet.
 */
export async function rasterizeSvg(svg: SVGSVGElement): Promise<{ canvas: HTMLCanvasElement; width: number; height: number }> {
  const width = Number(svg.getAttribute('width')) || svg.clientWidth;
  const height = Number(svg.getAttribute('height')) || svg.clientHeight;
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const src = [svg, ...svg.querySelectorAll('*')];
  const dst = [clone, ...clone.querySelectorAll('*')];
  src.forEach((el, i) => {
    const cs = getComputedStyle(el);
    const target = dst[i] as SVGElement;
    target.removeAttribute('class');
    let style = '';
    for (const p of STYLE_PROPS) style += `${p}:${cs.getPropertyValue(p)};`;
    target.setAttribute('style', style);
  });
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  clone.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const xml = new XMLSerializer().serializeToString(clone);
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * EXPORT_SCALE);
  canvas.height = Math.round(height * EXPORT_SCALE);
  canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return { canvas, width, height };
}

/** Legend entries from a rendered legend element (items with a `.swatch` and a label). */
export function legendFromDom(root: HTMLElement): LegendEntry[] {
  return [...root.querySelectorAll<HTMLElement>('.legend-item')].flatMap((item) => {
    if (item.classList.contains('off')) return [];
    const sw = item.querySelector<HTMLElement>('.swatch');
    const label = item.textContent?.trim() ?? '';
    return sw && label ? [{ color: getComputedStyle(sw).backgroundColor, label }] : [];
  });
}
