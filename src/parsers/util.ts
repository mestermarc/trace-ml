// Small tolerant coercion helpers shared by the parsers.

export type ParseResult<T> = { ok: true; value: T; warnings: string[] } | { ok: false; error: string };

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

export function asFiniteNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export function asInt(v: unknown): number | null {
  const n = asFiniteNumber(v);
  return n !== null && Number.isInteger(n) ? n : null;
}

/** Parses an ISO-8601 timestamp to epoch ms. Returns null for missing/invalid values. */
export function asTimestamp(v: unknown): number | null {
  if (typeof v !== 'string' || v === '') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

export function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.filter((x) => x !== null && x !== undefined).map((x) => String(x));
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * JSON.parse that also accepts the bare NaN / Infinity / -Infinity tokens Python's json module
 * emits by default; they become null (a gap), which is how TraceML treats non-finite values.
 */
export function parseJsonLenient(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    if (!/NaN|Infinity/.test(text)) throw e;
    const fixed = text.replace(/(?<=[:,[\s])(-?Infinity|NaN)(?=\s*[,}\]])/g, 'null');
    return JSON.parse(fixed);
  }
}
