import { describe, expect, it } from 'vitest';
import { barData, boxData, boxStats, groupLabel, groupRuns, logTicks, niceTicks, NONE_GROUP, numericValue, quantile, scatterData } from '../src/model/analysis';
import { filterRuns } from '../src/model/filters';
import { extractSeries, seriesXY } from '../src/model/metricSeries';
import { sortRuns } from '../src/model/run';
import { MetricsHistory } from '../src/parsers/metricsJsonl';
import { makeRun } from './helpers';

const best = (value: number | null) => ({ value, step: 1, epoch: 1, mode: 'max' });
const keys = (rs: { key: string }[]) => rs.map((r) => r.key);

const runs = [
  makeRun({ key: 'a', name: 'a', group: 'lr-sweep', tags: ['cv'], startedAt: Date.parse('2026-09-28T10:00:00Z'), params: { 'optim.lr': 3e-4, 'data.dataset': 'cifar10' }, best: { 'val/auc': best(0.9) }, summary: { 'test/auc': 0.88, ckpt: 'best.pt' } }),
  makeRun({ key: 'b', name: 'b', group: 'lr-sweep', tags: ['cv'], startedAt: Date.parse('2026-09-28T09:00:00Z'), params: { 'optim.lr': 3e-3, 'data.dataset': 'cifar100' }, best: { 'val/auc': best(0.7) }, summary: { 'test/auc': null } }),
  makeRun({ key: 'c', name: 'c', group: 'arch', tags: [], startedAt: null, params: { 'optim.lr': 1e-3, 'data.dataset': 'cifar10' }, best: { 'val/auc': best(0.85) }, summary: { 'test/auc': 0.84 } }),
  makeRun({ key: 'd', name: 'd', group: null, displayStatus: 'failed', status: 'failed', startedAt: Date.parse('2026-09-28T11:00:00Z'), params: { 'optim.lr': 'auto', 'data.dataset': 'cifar100' }, best: { 'val/auc': best(0.6) } }),
  makeRun({ key: 'e', name: 'e', group: 'arch', startedAt: Date.parse('2026-09-28T08:00:00Z'), params: { 'data.dataset': 'cifar10' }, best: {}, summary: { 'test/auc': Number.NaN } }),
];

describe('sorting (analysis requirements)', () => {
  it('numeric ascending / descending', () => {
    expect(keys(sortRuns(runs, [{ col: 'best:val/auc', dir: 'desc' }]))).toEqual(['a', 'c', 'b', 'd', 'e']);
    expect(keys(sortRuns(runs, [{ col: 'best:val/auc', dir: 'asc' }]))).toEqual(['d', 'b', 'c', 'a', 'e']);
  });

  it('string ascending / descending', () => {
    expect(keys(sortRuns(runs, [{ col: 'group', dir: 'asc' }]))).toEqual(['c', 'e', 'a', 'b', 'd']);
    expect(keys(sortRuns(runs, [{ col: 'group', dir: 'desc' }]))).toEqual(['a', 'b', 'c', 'e', 'd']);
  });

  it('timestamp sorting with missing start times last', () => {
    expect(keys(sortRuns(runs, [{ col: 'started', dir: 'asc' }]))).toEqual(['e', 'b', 'a', 'd', 'c']);
    expect(keys(sortRuns(runs, [{ col: 'started', dir: 'desc' }]))).toEqual(['d', 'a', 'b', 'e', 'c']);
  });

  it('null / missing / NaN values sort last without crashing, mixed types are ordered', () => {
    const r = sortRuns(runs, [{ col: 'summary:test/auc', dir: 'desc' }]);
    expect(keys(r).slice(0, 2)).toEqual(['a', 'c']);
    expect(keys(sortRuns(runs, [{ col: 'param:optim.lr', dir: 'asc' }]))).toEqual(['a', 'c', 'b', 'd', 'e']);
  });
});

describe('grouping', () => {
  it('groups by explicit group field with "(none)" last', () => {
    const g = groupRuns(runs, 'group');
    expect(g.map((x) => [x.label, keys(x.runs)])).toEqual([
      ['arch', ['c', 'e']],
      ['lr-sweep', ['a', 'b']],
      [NONE_GROUP, ['d']],
    ]);
  });

  it('groups by parameter value, numbers ordered numerically', () => {
    const g = groupRuns(runs, 'param:optim.lr');
    expect(g.map((x) => x.label)).toEqual(['0.0003', '0.001', '0.003', 'auto', NONE_GROUP]);
  });

  it('groups by tags and by status', () => {
    expect(groupRuns(runs, 'tags').map((x) => [x.label, x.runs.length])).toEqual([
      ['cv', 2],
      [NONE_GROUP, 3],
    ]);
    expect(groupRuns(runs, 'status').map((x) => x.label)).toEqual(['completed', 'failed']);
    expect(groupLabel(runs[3]!, 'group')).toBe(NONE_GROUP);
  });

  it('preserves the sort order inside groups', () => {
    const sorted = sortRuns(runs, [{ col: 'best:val/auc', dir: 'asc' }]);
    const g = groupRuns(sorted, 'param:data.dataset');
    expect(g.map((x) => [x.label, keys(x.runs)])).toEqual([
      ['cifar10', ['c', 'a', 'e']],
      ['cifar100', ['d', 'b']],
    ]);
  });

  it('filtering + grouping: groups reflect only the filtered runs', () => {
    const filtered = filterRuns(runs, { search: '', statuses: ['completed'], columns: { 'best:val/auc': '>= 0.8' } });
    expect(groupRuns(filtered, 'param:data.dataset').map((x) => [x.label, keys(x.runs)])).toEqual([['cifar10', ['a', 'c']]]);
  });
});

describe('scatter data', () => {
  it('extracts x/y per run and keeps run keys for click-through', () => {
    const d = scatterData(runs, 'param:optim.lr', 'best:val/auc');
    expect(d.points.map((p) => [p.key, p.x, p.y])).toEqual([
      ['a', 3e-4, 0.9],
      ['b', 3e-3, 0.7],
      ['c', 1e-3, 0.85],
    ]);
    expect(d.excluded).toBe(2); // d: non-numeric lr, e: missing lr and best
  });

  it('excludes missing, null, NaN and non-numeric values', () => {
    const d = scatterData(runs, 'best:val/auc', 'summary:test/auc');
    expect(d.points.map((p) => p.key)).toEqual(['a', 'c']);
    expect(d.excluded).toBe(3);
    expect(numericValue(runs[4]!, 'summary:test/auc')).toBeNull();
    expect(numericValue(runs[0]!, 'summary:ckpt')).toBeNull();
  });

  it('adds size (null when missing, point kept) and group labels', () => {
    const d = scatterData(runs, 'best:val/auc', 'best:val/auc', { sizeField: 'summary:test/auc', groupField: 'param:data.dataset' });
    expect(d.points.map((p) => [p.key, p.size, p.group])).toEqual([
      ['a', 0.88, 'cifar10'],
      ['b', null, 'cifar100'],
      ['c', 0.84, 'cifar10'],
      ['d', null, 'cifar100'],
    ]);
    expect(d.groups).toEqual(['cifar10', 'cifar100']);
  });

  it('updates after filtering', () => {
    const before = scatterData(runs, 'param:optim.lr', 'best:val/auc').points.length;
    const after = scatterData(filterRuns(runs, { search: 'lr-sweep', statuses: [], columns: {} }), 'param:optim.lr', 'best:val/auc').points;
    expect(before).toBe(3);
    expect(after.map((p) => p.key)).toEqual(['a', 'b']);
  });
});

describe('box data', () => {
  it('computes quartiles with linear interpolation', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4], 0.25)).toBe(1.75);
    expect(quantile([5], 0.75)).toBe(5);
  });

  it('computes box statistics, whiskers and outliers', () => {
    const vals = [1, 2, 3, 4, 5, 6, 7, 8, 100].map((v, i) => ({ key: `k${i}`, name: `n${i}`, value: v }));
    const b = boxStats('g', vals);
    expect(b).toMatchObject({ n: 9, min: 1, q1: 3, median: 5, q3: 7, max: 100, lo: 1, hi: 8 });
    expect(b.outliers.map((o) => o.value)).toEqual([100]);
    expect(b.values.map((v) => v.key)).toHaveLength(9);
  });

  it('builds one box per group, dropping missing values', () => {
    const d = boxData(runs, 'best:val/auc', 'param:data.dataset');
    expect(d.boxes.map((b) => [b.label, b.n])).toEqual([
      ['cifar10', 2],
      ['cifar100', 2],
    ]);
    expect(d.boxes[0]!.median).toBeCloseTo(0.875);
    expect(d.boxes[1]!.median).toBeCloseTo(0.65);
    expect(d.excluded).toBe(1);
    expect(d.boxes[0]!.values.map((v) => v.key)).toEqual(['c', 'a']);
  });

  it('single box without a group field; empty groups are dropped', () => {
    expect(boxData(runs, 'best:val/auc', null).boxes.map((b) => [b.label, b.n])).toEqual([['all runs', 4]]);
    expect(boxData(runs, 'summary:test/auc', 'group').boxes.map((b) => b.label)).toEqual(['arch', 'lr-sweep']);
  });

  it('updates after filtering', () => {
    const filtered = filterRuns(runs, { search: '', statuses: ['failed'], columns: {} });
    expect(boxData(filtered, 'best:val/auc', 'param:data.dataset').boxes.map((b) => [b.label, b.n])).toEqual([['cifar100', 1]]);
  });
});

describe('axis ticks', () => {
  it('nice linear ticks', () => {
    expect(niceTicks(0, 1, 5)).toEqual([0, 0.2, 0.4, 0.6, 0.8, 1]);
    expect(niceTicks(0.62, 0.91, 5)).toEqual([0.65, 0.7, 0.75, 0.8, 0.85, 0.9]);
    expect(niceTicks(5, 5).length).toBeGreaterThan(0);
  });

  it('log ticks are powers of ten', () => {
    expect(logTicks(1e-4, 5e-3)).toEqual([1e-4, 2e-4, 5e-4, 1e-3, 2e-3, 5e-3]);
    expect(logTicks(1e-6, 1)).toEqual([1e-6, 1e-5, 1e-4, 1e-3, 1e-2, 0.1, 1]);
    expect(logTicks(0, 1)).toEqual([]);
  });
});

describe('line-plot epoch data', () => {
  const h = new MetricsHistory();
  h.ingest(
    new TextEncoder().encode(
      [
        '{"step": 0, "epoch": 0, "time": 10, "val/dice": 0.5}',
        '{"step": 1, "epoch": 1, "time": 20, "train/loss": 0.3}',
        '{"step": 1, "epoch": 1, "time": 21, "val/dice": null}',
        '{"step": 2, "time": 30, "val/dice": 0.7}',
        '{"step": 3, "epoch": 3, "time": 40, "val/dice": 0.8}',
        '{"step": 3, "epoch": 3, "time": 41, "val/dice": 0.82}',
      ].join('\n') + '\n',
    ),
  );
  const p = extractSeries(h, 'r', 'val/dice', 0, 5000);

  it('uses epoch as x, drops rows without an epoch, keeps nulls as gaps, last duplicate wins', () => {
    expect(seriesXY(p, 'epoch', false)).toEqual({ x: [0, 1, 3], y: [0.5, null, 0.82] });
    expect(seriesXY(p, 'step', false)).toEqual({ x: [0, 1, 2, 3], y: [0.5, null, 0.7, 0.82] });
  });

  it('sorts out-of-order x and hides non-positive values on log-y', () => {
    const q = { ...p, step: [3, 1, 2], epoch: [3, 1, 2], wall: [3, 1, 2], y: [0.5, -1, 0.2] };
    expect(seriesXY(q, 'step', true)).toEqual({ x: [1, 2, 3], y: [null, 0.2, 0.5] });
  });
});

describe('bar data', () => {
  it('one bar per run, sorted descending, missing values excluded, keys kept for click-through', () => {
    const d = barData(runs, 'best:val/auc', { mode: 'runs', groupField: null, sort: 'desc' });
    expect(d.bars.map((b) => [b.key, b.value])).toEqual([['a', 0.9], ['c', 0.85], ['b', 0.7], ['d', 0.6]]);
    expect(d.excluded).toBe(1);
  });

  it('ascending, table order, and the run limit', () => {
    expect(barData(runs, 'best:val/auc', { mode: 'runs', groupField: null, sort: 'asc' }).bars.map((b) => b.key)).toEqual(['d', 'b', 'c', 'a']);
    expect(barData(runs, 'best:val/auc', { mode: 'runs', groupField: null, sort: 'table' }).bars.map((b) => b.key)).toEqual(['a', 'b', 'c', 'd']);
    const lim = barData(runs, 'best:val/auc', { mode: 'runs', groupField: null, sort: 'desc', limit: 2 });
    expect(lim.bars.map((b) => b.key)).toEqual(['a', 'c']);
    expect(lim.truncated).toBe(2);
  });

  it('runs mode carries the group label for colouring', () => {
    const d = barData(runs, 'best:val/auc', { mode: 'runs', groupField: 'param:data.dataset', sort: 'desc' });
    expect(d.bars.map((b) => b.group)).toEqual(['cifar10', 'cifar10', 'cifar100', 'cifar100']);
  });

  it('groups mode: mean with min/max and n per group', () => {
    const d = barData(runs, 'best:val/auc', { mode: 'groups', groupField: 'param:data.dataset', sort: 'desc' });
    expect(d.bars.map((b) => [b.label, b.n, b.min, b.max])).toEqual([['cifar10', 2, 0.85, 0.9], ['cifar100', 2, 0.6, 0.7]]);
    expect(d.bars[0]!.value).toBeCloseTo(0.875);
    expect(d.excluded).toBe(1);
  });

  it('updates after filtering', () => {
    const filtered = filterRuns(runs, { search: 'lr-sweep', statuses: [], columns: {} });
    expect(barData(filtered, 'best:val/auc', { mode: 'runs', groupField: null, sort: 'desc' }).bars.map((b) => b.key)).toEqual(['a', 'b']);
  });
});
