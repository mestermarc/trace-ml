import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunSummary } from '../src/types';

export const FIXTURES = join(__dirname, 'fixtures');

export function fixture(...parts: string[]): string {
  return readFileSync(join(FIXTURES, ...parts), 'utf-8');
}

export function tempDir(prefix = 'traceml-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Builds a RunSummary with sensible defaults for UI/data logic tests. */
export function makeRun(over: Partial<RunSummary> & { key: string }): RunSummary {
  return {
    id: over.key,
    name: over.key,
    group: null,
    tags: [],
    notes: '',
    status: 'completed',
    displayStatus: 'completed',
    heartbeatKnown: true,
    startedAt: null,
    endedAt: null,
    heartbeatAt: null,
    durationS: null,
    step: null,
    epoch: null,
    params: {},
    last: {},
    best: {},
    summary: {},
    metricNames: [],
    warnings: [],
    legacy: false,
    location: over.key,
    ...over,
  };
}
