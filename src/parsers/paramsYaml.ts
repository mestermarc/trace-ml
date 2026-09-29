import { parse } from 'yaml';
import type { Scalar } from '../types';
import { errorMessage, isRecord, type ParseResult } from './util';

function toScalar(v: unknown): Scalar {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : String(v);
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) return v.toISOString();
  // Lists and other non-scalars are shown as compact JSON.
  return JSON.stringify(v);
}

/** Flattens nested mappings into dot-separated keys (legacy nested params.yaml). */
export function flattenParams(obj: Record<string, unknown>, prefix = '', out: Record<string, Scalar> = {}): Record<string, Scalar> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (isRecord(v) && !(v instanceof Date) && Object.keys(v).length > 0) flattenParams(v, key, out);
    else out[key] = toScalar(isRecord(v) ? null : v);
  }
  return out;
}

export function parseParamsYaml(text: string): ParseResult<Record<string, Scalar>> {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (e) {
    return { ok: false, error: `params.yaml: invalid YAML (${errorMessage(e).split('\n')[0]})` };
  }
  if (raw === null || raw === undefined) return { ok: true, value: {}, warnings: [] };
  if (!isRecord(raw)) return { ok: false, error: 'params.yaml: expected a mapping at the top level' };
  return { ok: true, value: flattenParams(raw), warnings: [] };
}
