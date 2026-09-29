import { describe, expect, it } from 'vitest';
import { buildRunSummary, computeDurationS, deriveDisplayStatus, type SummaryInput } from '../src/model/run';
import { parseRunJson } from '../src/parsers/runJson';
import type { RunMeta } from '../src/types';

const NOW = Date.parse('2026-09-29T12:00:00Z');
const sec = (s: number) => NOW - s * 1000;

describe('deriveDisplayStatus', () => {
  it.each(['completed', 'failed', 'killed'] as const)('keeps %s even with an old heartbeat', (status) => {
    expect(deriveDisplayStatus(status, sec(3600), NOW, 60)).toEqual({ displayStatus: status, heartbeatKnown: true });
  });

  it('running with a fresh heartbeat', () => {
    expect(deriveDisplayStatus('running', sec(10), NOW, 60).displayStatus).toBe('running');
  });

  it('running with an old heartbeat is stale', () => {
    expect(deriveDisplayStatus('running', sec(61), NOW, 60).displayStatus).toBe('stale');
    expect(deriveDisplayStatus('running', sec(59), NOW, 60).displayStatus).toBe('running');
  });

  it('respects a custom staleAfterSeconds', () => {
    expect(deriveDisplayStatus('running', sec(200), NOW, 300).displayStatus).toBe('running');
  });

  it('running without heartbeat stays running with unknown staleness', () => {
    expect(deriveDisplayStatus('running', null, NOW, 60)).toEqual({ displayStatus: 'running', heartbeatKnown: false });
  });

  it('legacy unknown stays unknown', () => {
    expect(deriveDisplayStatus('unknown', null, NOW, 60).displayStatus).toBe('unknown');
  });
});

function meta(over: Partial<RunMeta>): RunMeta {
  const r = parseRunJson('{}');
  if (!r.ok) throw new Error('unreachable');
  return { ...r.value, ...over };
}

describe('computeDurationS', () => {
  it('prefers duration_s', () => {
    expect(computeDurationS(meta({ durationS: 12, startedAt: sec(100) }), 'completed', NOW)).toBe(12);
  });
  it('uses ended - started', () => {
    expect(computeDurationS(meta({ startedAt: sec(100), endedAt: sec(40) }), 'failed', NOW)).toBe(60);
  });
  it('uses now for running runs', () => {
    expect(computeDurationS(meta({ startedAt: sec(100) }), 'running', NOW)).toBe(100);
  });
  it('uses the heartbeat for stale runs', () => {
    expect(computeDurationS(meta({ startedAt: sec(1000), heartbeatAt: sec(400) }), 'stale', NOW)).toBe(600);
  });
  it('is null without a start time', () => {
    expect(computeDurationS(meta({}), 'running', NOW)).toBeNull();
    expect(computeDurationS(null, 'unknown', NOW)).toBeNull();
  });
});

describe('buildRunSummary', () => {
  const base: SummaryInput = {
    key: '/r/runs/x',
    dirName: 'x',
    location: 'runs/x',
    meta: null,
    hasRunJson: false,
    params: { a: 1 },
    metrics: null,
    extraMetricNames: ['train/loss'],
    historyStep: null,
    warnings: [],
  };

  it('builds a legacy run from the directory name', () => {
    const s = buildRunSummary(base, NOW, 60);
    expect(s).toMatchObject({ id: 'x', name: 'x', status: 'unknown', displayStatus: 'unknown', legacy: true, metricNames: ['train/loss'] });
  });

  it('derives stale for a running run.json', () => {
    const s = buildRunSummary({ ...base, hasRunJson: true, meta: meta({ status: 'running', name: 'n', startedAt: sec(900), heartbeatAt: sec(300) }) }, NOW, 60);
    expect(s.displayStatus).toBe('stale');
    expect(s.status).toBe('running');
    expect(s.legacy).toBe(false);
    expect(s.durationS).toBe(600);
  });
});
