// Activity-bar run list, searchable picker matching, and the hidden-switch-checkbox regression.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { explorerGroups, keyMetric, runDescription, shortAge } from '../src/model/explorer';
import { matchItem } from '../src/webview/ui';
import { makeRun } from './helpers';

const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);

describe('activity-bar run list', () => {
  const runs = [
    makeRun({ key: 'a', name: 'a', displayStatus: 'completed', startedAt: NOW - 3_600_000 }),
    makeRun({ key: 'b', name: 'b', displayStatus: 'failed', startedAt: NOW - 60_000 }),
    makeRun({ key: 'c', name: 'c', displayStatus: 'running', status: 'running', startedAt: NOW - 120_000, step: 12 }),
    makeRun({ key: 'd', name: 'd', displayStatus: 'completed', startedAt: NOW - 60_000 }),
    makeRun({ key: 'e', name: 'e', displayStatus: 'stale', status: 'running', startedAt: null }),
  ];

  it('groups by status, attention first, newest first, empty groups left out', () => {
    const g = explorerGroups(runs);
    expect(g.map((x) => [x.status, x.expanded, x.runs.map((r) => r.key)])).toEqual([
      ['running', true, ['c']],
      ['stale', true, ['e']],
      ['failed', true, ['b']],
      ['completed', false, ['d', 'a']],
    ]);
    expect(explorerGroups([])).toEqual([]);
  });

  it('describes a run by key metric, step while running, and age', () => {
    const r = makeRun({ key: 'x', displayStatus: 'running', step: 12, startedAt: NOW - 7_200_000, best: { 'val/auc': { value: 0.89412, step: 3, epoch: 3, mode: 'max' } } });
    expect(runDescription(r, NOW)).toBe('val/auc 0.8941 · step 12 · 2h');
    expect(keyMetric(makeRun({ key: 'y', summary: { note: 'x', 'test/acc': 0.5 } }))).toBe('test/acc 0.5');
    expect(keyMetric(makeRun({ key: 'z' }))).toBeNull();
    expect([shortAge(NOW - 5_000, NOW), shortAge(NOW - 300_000, NOW), shortAge(NOW - 86_400_000 * 3, NOW), shortAge(NOW - 86_400_000 * 30, NOW), shortAge(null, NOW)]).toEqual(['now', '5m', '3d', '4w', '']);
  });
});

describe('searchable picker', () => {
  const item = { value: 'param:optim.lr', label: 'optim.lr', section: 'Config', keywords: 'param:optim.lr' };
  it('matches any part of the name, case-insensitively, all words required', () => {
    expect(matchItem(item, '')).toBeNull();
    expect(matchItem(item, 'LR')).toEqual({ start: 6, end: 8 });
    expect(matchItem(item, 'optim config')).toEqual({ start: 0, end: 5 });
    expect(matchItem(item, 'batch')).toBe(false);
    expect(matchItem(item, 'param')).toBeNull(); // found via keywords; nothing to highlight in the label
  });
});

describe('switch checkbox stays hidden (regression: "Colour by group" showed a stray check box)', () => {
  const css = readFileSync(join(__dirname, '..', 'src', 'webview', 'styles', 'components.css'), 'utf-8');
  it('the switch input rule outranks the generic checkbox rules, including :disabled', () => {
    const rule = /input\[type='checkbox'\]\.switch-input,\s*input\[type='checkbox'\]\.switch-input:disabled,\s*input\[type='checkbox'\]\.switch-input:checked\s*\{([^}]*)\}/.exec(css);
    expect(rule, 'switch input rule').not.toBeNull();
    expect(rule![1]).toMatch(/opacity:\s*0;/);
    expect(rule![1]).toMatch(/width:\s*1px;/);
    expect(css).toMatch(/input\[type='checkbox'\]\.switch-input::after\s*\{\s*content:\s*none;/);
  });
});
