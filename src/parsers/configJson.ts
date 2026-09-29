import { errorMessage, parseJsonLenient, type ParseResult } from './util';

/** config.json is shown as-is (nested) in the detail view; any JSON value is accepted. */
export function parseConfigJson(text: string): ParseResult<unknown> {
  try {
    return { ok: true, value: parseJsonLenient(text), warnings: [] };
  } catch (e) {
    return { ok: false, error: `config.json: invalid JSON (${errorMessage(e)})` };
  }
}
