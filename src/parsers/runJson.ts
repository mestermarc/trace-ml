import { SUPPORTED_SCHEMA_VERSION, type ExitInfo, type GitInfo, type HostInfo, type RunMeta, type RunStatus } from '../types';
import { asFiniteNumber, asInt, asString, asStringArray, asTimestamp, errorMessage, isRecord, parseJsonLenient, type ParseResult } from './util';

const STATUSES: readonly RunStatus[] = ['running', 'completed', 'failed', 'killed'];

function parseExit(v: unknown): ExitInfo | null {
  if (!isRecord(v)) return null;
  // Accept both a flat layout and a nested `error: {type, message, traceback}` object.
  const err = isRecord(v.error) ? v.error : {};
  const tb = v.traceback ?? err.traceback;
  return {
    code: asInt(v.code),
    signal: asString(v.signal) ?? (typeof v.signal === 'number' ? String(v.signal) : null),
    errorType: asString(v.error_type) ?? asString(err.type),
    errorMessage: asString(v.error_message) ?? asString(err.message) ?? (typeof v.error === 'string' ? v.error : null),
    traceback: typeof tb === 'string' ? tb : Array.isArray(tb) ? tb.map(String).join('\n') : null,
  };
}

export function parseRunJson(text: string): ParseResult<RunMeta> {
  let raw: unknown;
  try {
    raw = parseJsonLenient(text);
  } catch (e) {
    return { ok: false, error: `run.json: invalid JSON (${errorMessage(e)})` };
  }
  if (!isRecord(raw)) return { ok: false, error: 'run.json: expected a JSON object' };

  const warnings: string[] = [];
  const schemaVersion = asInt(raw.schema_version);
  if (schemaVersion !== null && schemaVersion > SUPPORTED_SCHEMA_VERSION) {
    warnings.push(`run.json: schema_version ${schemaVersion} is newer than supported (${SUPPORTED_SCHEMA_VERSION}); showing known fields only`);
  }

  let status: RunStatus = 'unknown';
  if (typeof raw.status === 'string' && (STATUSES as readonly string[]).includes(raw.status)) {
    status = raw.status as RunStatus;
  } else {
    warnings.push(`run.json: unrecognised status ${JSON.stringify(raw.status ?? null)}`);
  }

  const ts = (key: string): number | null => {
    const v = raw[key];
    const t = asTimestamp(v);
    if (t === null && v !== null && v !== undefined) warnings.push(`run.json: invalid timestamp in ${key}`);
    return t;
  };

  const tags = asStringArray(raw.tags) ?? [];
  const command = Array.isArray(raw.command) ? raw.command.map(String) : typeof raw.command === 'string' ? [raw.command] : null;

  return {
    ok: true,
    warnings,
    value: {
      schemaVersion,
      id: asString(raw.id),
      name: asString(raw.name),
      group: asString(raw.group),
      tags,
      notes: asString(raw.notes) ?? '',
      status,
      startedAt: ts('started_at'),
      endedAt: ts('ended_at'),
      heartbeatAt: ts('heartbeat_at'),
      durationS: asFiniteNumber(raw.duration_s),
      exit: parseExit(raw.exit),
      command,
      cwd: asString(raw.cwd),
      host: isRecord(raw.host) ? (raw.host as HostInfo) : null,
      git: isRecord(raw.git) ? (raw.git as GitInfo) : null,
    },
  };
}
