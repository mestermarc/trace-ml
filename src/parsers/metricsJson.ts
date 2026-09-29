import { SUPPORTED_SCHEMA_VERSION, type BestMetric, type MetricsSummary, type Scalar } from '../types';
import { asFiniteNumber, asInt, asString, asTimestamp, errorMessage, isRecord, parseJsonLenient, type ParseResult } from './util';

function numberMap(v: unknown): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  if (!isRecord(v)) return out;
  for (const [k, x] of Object.entries(v)) {
    if (typeof x === 'number' || x === null) out[k] = asFiniteNumber(x);
  }
  return out;
}

function bestMap(v: unknown): Record<string, BestMetric> {
  const out: Record<string, BestMetric> = {};
  if (!isRecord(v)) return out;
  for (const [k, x] of Object.entries(v)) {
    if (isRecord(x)) {
      out[k] = { value: asFiniteNumber(x.value), step: asInt(x.step), epoch: asInt(x.epoch), mode: asString(x.mode) };
    } else if (typeof x === 'number') {
      out[k] = { value: asFiniteNumber(x), step: null, epoch: null, mode: null };
    }
  }
  return out;
}

function scalarMap(v: unknown): Record<string, Scalar> {
  const out: Record<string, Scalar> = {};
  if (!isRecord(v)) return out;
  for (const [k, x] of Object.entries(v)) {
    if (x === null || typeof x === 'string' || typeof x === 'boolean') out[k] = x;
    else if (typeof x === 'number') out[k] = asFiniteNumber(x);
  }
  return out;
}

export function parseMetricsJson(text: string): ParseResult<MetricsSummary> {
  let raw: unknown;
  try {
    raw = parseJsonLenient(text);
  } catch (e) {
    return { ok: false, error: `metrics.json: invalid JSON (${errorMessage(e)})` };
  }
  if (!isRecord(raw)) return { ok: false, error: 'metrics.json: expected a JSON object' };
  const warnings: string[] = [];
  const schemaVersion = asInt(raw.schema_version);
  if (schemaVersion !== null && schemaVersion > SUPPORTED_SCHEMA_VERSION) {
    warnings.push(`metrics.json: schema_version ${schemaVersion} is newer than supported (${SUPPORTED_SCHEMA_VERSION})`);
  }
  return {
    ok: true,
    warnings,
    value: {
      schemaVersion,
      updatedAt: asTimestamp(raw.updated_at),
      step: asFiniteNumber(raw.step),
      epoch: asFiniteNumber(raw.epoch),
      last: numberMap(raw.last),
      best: bestMap(raw.best),
      summary: scalarMap(raw.summary),
    },
  };
}
