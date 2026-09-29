import { describe, expect, it } from 'vitest';
import { parseRunJson } from '../../src/parsers/runJson';
import { fixture } from '../helpers';

describe('parseRunJson', () => {
  it('parses a normal run.json', () => {
    const r = parseRunJson(fixture('normal-run', 'run.json'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const m = r.value;
    expect(m.id).toBe('20260929-154600_mlp-baseline_a3f1');
    expect(m.name).toBe('mlp-baseline');
    expect(m.group).toBe('lr-sweep');
    expect(m.tags).toEqual(['cv']);
    expect(m.status).toBe('running');
    expect(m.startedAt).toBe(Date.parse('2026-09-29T13:46:00Z'));
    expect(m.endedAt).toBeNull();
    expect(m.heartbeatAt).toBe(Date.parse('2026-09-29T13:47:10Z'));
    expect(m.command).toEqual(['python', 'train.py', '--lr', '3e-4']);
    expect(m.host?.hostname).toBe('gpu01');
    expect(m.git?.dirty).toBe(true);
    expect(r.warnings).toEqual([]);
  });

  it('ignores unknown keys', () => {
    const r = parseRunJson(fixture('normal-run', 'run.json'));
    expect(r.ok && 'some_future_key' in r.value).toBe(false);
  });

  it('rejects malformed JSON without throwing', () => {
    const r = parseRunJson(fixture('corrupt-run', 'run.json'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/run\.json: invalid JSON/);
  });

  it('rejects non-object JSON', () => {
    expect(parseRunJson('[1,2]').ok).toBe(false);
  });

  it('warns about a newer schema_version but parses known fields', () => {
    const r = parseRunJson(fixture('future-run', 'run.json'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe('completed');
    expect(r.value.durationS).toBe(3600);
    expect(r.warnings.some((w) => w.includes('schema_version 2'))).toBe(true);
  });

  it('parses failure details from a flat exit object', () => {
    const r = parseRunJson(
      JSON.stringify({
        status: 'failed',
        exit: { code: 1, signal: null, error_type: 'RuntimeError', error_message: 'boom', traceback: 'Traceback...\nRuntimeError: boom' },
      }),
    );
    expect(r.ok && r.value.exit).toEqual({
      code: 1,
      signal: null,
      errorType: 'RuntimeError',
      errorMessage: 'boom',
      traceback: 'Traceback...\nRuntimeError: boom',
    });
  });

  it('parses failure details from a nested error object', () => {
    const r = parseRunJson(JSON.stringify({ status: 'failed', exit: { code: 1, error: { type: 'ValueError', message: 'nan', traceback: ['a', 'b'] } } }));
    expect(r.ok && r.value.exit?.errorType).toBe('ValueError');
    expect(r.ok && r.value.exit?.traceback).toBe('a\nb');
  });

  it('maps an unrecognised status to unknown with a warning', () => {
    const r = parseRunJson(JSON.stringify({ status: 'paused' }));
    expect(r.ok && r.value.status).toBe('unknown');
    expect(r.ok && r.warnings.length).toBe(1);
  });

  it('flags invalid timestamps instead of inventing them', () => {
    const r = parseRunJson(JSON.stringify({ status: 'running', heartbeat_at: 'yesterday' }));
    expect(r.ok && r.value.heartbeatAt).toBeNull();
    expect(r.ok && r.warnings.some((w) => w.includes('heartbeat_at'))).toBe(true);
  });
});
