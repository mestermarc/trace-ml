// PNG helpers for saved plots. Pure (Uint8Array only). The webview renders the chart at 300 DPI
// scale; the host checks the bytes are a PNG and stamps the resolution into a pHYs chunk so image
// tools (Word, LaTeX, Inkscape...) see 300 DPI instead of the default 72/96.

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export const PLOT_DPI = 300;
/** Upper bound for a plot sent by the webview. */
export const MAX_PNG_BYTES = 40 * 1024 * 1024;

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const u32 = (b: Uint8Array, i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;

function putU32(b: Uint8Array, i: number, v: number): void {
  b[i] = (v >>> 24) & 0xff;
  b[i + 1] = (v >>> 16) & 0xff;
  b[i + 2] = (v >>> 8) & 0xff;
  b[i + 3] = v & 0xff;
}

/** True when the bytes start with the PNG signature followed by an IHDR chunk. */
export function isPng(b: Uint8Array): boolean {
  if (b.length < 33) return false;
  for (let i = 0; i < 8; i++) if (b[i] !== SIGNATURE[i]) return false;
  return u32(b, 8) === 13 && String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!) === 'IHDR';
}

/** Image size from the IHDR chunk. */
export function pngSize(b: Uint8Array): { width: number; height: number } {
  return { width: u32(b, 16), height: u32(b, 20) };
}

/** Returns a copy of the PNG with a pHYs chunk (pixels per metre) for `dpi`, replacing any existing one. */
export function setPngDpi(b: Uint8Array, dpi = PLOT_DPI): Uint8Array {
  if (!isPng(b)) throw new Error('not a PNG image');
  const ppm = Math.round(dpi / 0.0254);
  const phys = new Uint8Array(4 + 4 + 9 + 4);
  putU32(phys, 0, 9);
  phys.set([0x70, 0x48, 0x59, 0x73], 4); // 'pHYs'
  putU32(phys, 8, ppm);
  putU32(phys, 12, ppm);
  phys[16] = 1; // unit: metre
  putU32(phys, 17, crc32(phys.subarray(4, 17)));

  const parts: Uint8Array[] = [b.subarray(0, 8)];
  let i = 8;
  let inserted = false;
  while (i + 12 <= b.length) {
    const len = u32(b, i);
    const end = i + 12 + len;
    if (end > b.length) throw new Error('truncated PNG chunk');
    const type = String.fromCharCode(b[i + 4]!, b[i + 5]!, b[i + 6]!, b[i + 7]!);
    if (type !== 'pHYs') parts.push(b.subarray(i, end));
    if (type === 'IHDR' && !inserted) {
      parts.push(phys);
      inserted = true;
    }
    i = end;
    if (type === 'IEND') break;
  }
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Reads the DPI from a pHYs chunk (null when absent). Used by tests. */
export function pngDpi(b: Uint8Array): number | null {
  let i = 8;
  while (i + 12 <= b.length) {
    const len = u32(b, i);
    const type = String.fromCharCode(b[i + 4]!, b[i + 5]!, b[i + 6]!, b[i + 7]!);
    if (type === 'pHYs' && b[i + 16] === 1) return Math.round(u32(b, i + 8) * 0.0254);
    i += 12 + len;
  }
  return null;
}
