import { describe, expect, it } from 'vitest';
import { columnValue, compareScalars, sortRuns, toggleSort } from '../src/model/run';
import { makeRun } from './helpers';

const keys = (rs: { key: string }[]) => rs.map((r) => r.key);

describe('sortRuns', () => {
  const runs = [
    makeRun({ key: 'a', name: 'run-10', params: { lr: 0.001, opt: 'sgd' }, best: { auc: { value: 0.8, step: 1, epoch: 1, mode: 'max' } } }),
    makeRun({ key: 'b', name: 'run-2', params: { lr: 0.0003, opt: 'adamw' } }),
    makeRun({ key: 'c', name: 'run-1', params: { lr: 0.001, opt: 'adamw' }, best: { auc: { value: 0.9, step: 1, epoch: 1, mode: 'max' } } }),
    makeRun({ key: 'd', name: 'Run-3', params: {} }),
  ];

  it('numeric ascending and descending, nulls last in both directions', () => {
    expect(keys(sortRuns(runs, [{ col: 'param:lr', dir: 'asc' }]))).toEqual(['b', 'a', 'c', 'd']);
    expect(keys(sortRuns(runs, [{ col: 'param:lr', dir: 'desc' }]))).toEqual(['a', 'c', 'b', 'd']);
    expect(keys(sortRuns(runs, [{ col: 'best:auc', dir: 'desc' }]))).toEqual(['c', 'a', 'b', 'd']);
    expect(keys(sortRuns(runs, [{ col: 'best:auc', dir: 'asc' }]))).toEqual(['a', 'c', 'b', 'd']);
  });

  it('strings sort naturally and case-insensitively', () => {
    expect(keys(sortRuns(runs, [{ col: 'name', dir: 'asc' }]))).toEqual(['c', 'b', 'd', 'a']);
  });

  it('multi-key sort', () => {
    expect(keys(sortRuns(runs, [{ col: 'param:lr', dir: 'desc' }, { col: 'param:opt', dir: 'asc' }]))).toEqual(['c', 'a', 'b', 'd']);
  });

  it('is stable and does not mutate the input', () => {
    const copy = runs.slice();
    expect(keys(sortRuns(runs, [{ col: 'group', dir: 'asc' }]))).toEqual(['a', 'b', 'c', 'd']);
    expect(runs).toEqual(copy);
  });

  it('numbers sort before strings in a mixed column', () => {
    expect(compareScalars(5, 'a')).toBeLessThan(0);
    expect(compareScalars(true, false)).toBeGreaterThan(0);
  });

  it('status column uses the display status', () => {
    expect(columnValue(makeRun({ key: 'x', status: 'running', displayStatus: 'stale' }), 'status')).toBe('stale');
  });
});

describe('toggleSort', () => {
  it('plain click replaces, toggles direction on repeat', () => {
    let k = toggleSort([], 'name', false);
    expect(k).toEqual([{ col: 'name', dir: 'asc' }]);
    k = toggleSort(k, 'name', false);
    expect(k).toEqual([{ col: 'name', dir: 'desc' }]);
    k = toggleSort(k, 'step', false);
    expect(k).toEqual([{ col: 'step', dir: 'asc' }]);
  });

  it('shift-click adds a secondary key or toggles an existing one', () => {
    let k = toggleSort([{ col: 'name', dir: 'asc' }], 'step', true);
    expect(k).toEqual([{ col: 'name', dir: 'asc' }, { col: 'step', dir: 'asc' }]);
    k = toggleSort(k, 'step', true);
    expect(k).toEqual([{ col: 'name', dir: 'asc' }, { col: 'step', dir: 'desc' }]);
  });
});
