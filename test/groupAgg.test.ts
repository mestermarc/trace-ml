// "Plot by groups" and group statistics: means per group for curves, scatter points, table rows.
import { describe, expect, it } from 'vitest';
import { scatterData } from '../src/model/analysis';
import { groupColumnStats, groupMeanSeries, isStatColumn, plotGroups, scatterGroupMeans, stats } from '../src/model/groupAgg';
import { lineGroupCsv, scatterGroupCsv } from '../src/model/plotData';
import { FIXED_COLUMNS, dynamicColumns } from '../src/model/run';
import { MetricsHistory } from '../src/parsers/metricsJsonl';
import { parseWebviewMessage } from '../src/protocol';
import type { SeriesPayload } from '../src/types';
import { makeRun } from './helpers';

const series = (step: number[], y: (number | null)[], over: Partial<SeriesPayload> = {}): SeriesPayload => ({
  runKey: 'r',
  metric: 'loss',
  step,
  epoch: step,
  wall: step.map((s) => s * 10),
  y,
  total: y.length,
  version: 1,
  ...over,
});

describe('group statistics', () => {
  it('mean, min, max and sample std', () => {
    expect(stats([1, 2, 3, 4])).toEqual({ n: 4, mean: 2.5, min: 1, max: 4, std: expect.closeTo(1.2910, 3) });
    expect(stats([5])).toEqual({ n: 1, mean: 5, min: 5, max: 5, std: 0 });
    expect(stats([])).toBeNull();
    expect(stats([NaN, Infinity, 2])).toEqual({ n: 1, mean: 2, min: 2, max: 2, std: 0 });
  });

  it('table group rows: numeric logged values, duration and step get a mean; text and timestamps do not', () => {
    const runs = [
      makeRun({ key: 'a', durationS: 100, params: { lr: 0.1, opt: 'adam' }, best: { auc: { value: 0.8, step: 1, epoch: 1, mode: 'max' } } }),
      makeRun({ key: 'b', durationS: 300, params: { lr: 0.3, opt: 'sgd' }, best: { auc: { value: 0.9, step: 1, epoch: 1, mode: 'max' } } }),
      makeRun({ key: 'c', durationS: null, params: { opt: 'sgd' } }),
    ];
    const cols = [...FIXED_COLUMNS, ...dynamicColumns(runs)];
    expect(cols.filter(isStatColumn).map((c) => c.id)).toEqual(['duration', 'step', 'param:lr', 'best:auc']);
    const st = groupColumnStats(runs, cols);
    expect(st.get('duration')).toMatchObject({ n: 2, mean: 200, min: 100, max: 300 });
    expect(st.get('param:lr')!.mean).toBeCloseTo(0.2);
    expect(st.get('best:auc')!.mean).toBeCloseTo(0.85);
    expect(st.get('step')).toBeNull(); // no run has a step
    expect(st.has('param:opt')).toBe(false);
    expect(st.has('started')).toBe(false);
  });
});

describe('group mean curves (Plot by groups)', () => {
  it('8 runs in 2 groups become 2 curves, each the mean across its runs per step', () => {
    const runs = Array.from({ length: 8 }, (_, i) => makeRun({ key: `r${i}`, params: { opt: i < 4 ? 'adam' : 'sgd' } }));
    const groups = plotGroups(runs, 'param:opt');
    expect(groups.map((g) => [g.label, g.runs.length])).toEqual([['adam', 4], ['sgd', 4]]);
    const curve = (k: number) => series([0, 1, 2], [k, k + 1, k + 2]);
    const adam = groupMeanSeries([0, 1, 2, 3].map(curve), 'step', false);
    expect(adam).toEqual({ x: [0, 1, 2], y: [1.5, 2.5, 3.5], n: [4, 4, 4] });
  });

  it('runs of different length: the mean uses the runs that have the step; gaps stay gaps', () => {
    const m = groupMeanSeries([series([0, 1, 2], [1, null, 3]), series([0, 1], [3, 5])], 'step', false);
    expect(m).toEqual({ x: [0, 1, 2], y: [2, 5, 3], n: [2, 1, 1] });
    expect(groupMeanSeries([series([0], [null]), series([0], [null])], 'step', false)).toEqual({ x: [0], y: [null], n: [0] });
    expect(groupMeanSeries([], 'step', false)).toEqual({ x: [], y: [], n: [] });
  });

  it('a run counts once per step (its last value), matching the single-run curves', () => {
    const m = groupMeanSeries([series([0, 0, 1], [10, 2, 4]), series([0, 1], [4, 6])], 'step', false);
    expect(m.y).toEqual([3, 5]);
  });

  it('epoch mode matches by epoch; wall mode uses the mean wall time of each step', () => {
    const a = series([0, 1], [1, 2], { epoch: [5, 6], wall: [0, 100] });
    const b = series([0, 1], [3, 4], { epoch: [5, 6], wall: [10, 120] });
    expect(groupMeanSeries([a, b], 'epoch', false).x).toEqual([5, 6]);
    expect(groupMeanSeries([a, b], 'wall', false)).toEqual({ x: [5, 110], y: [2, 3], n: [2, 2] });
  });

  it('log scale: non-positive means become gaps', () => {
    expect(groupMeanSeries([series([0, 1], [-1, 2]), series([0, 1], [0.5, 2])], 'step', true).y).toEqual([null, 2]);
  });
});

describe('scatter by groups', () => {
  it('one point per group at the mean, with count and spread', () => {
    const runs = [
      makeRun({ key: 'a', params: { x: 1, y: 10, g: 'A' } }),
      makeRun({ key: 'b', params: { x: 3, y: 20, g: 'A' } }),
      makeRun({ key: 'c', params: { x: 5, y: 7, g: 'B' } }),
      makeRun({ key: 'd', params: { x: null, y: 1, g: 'B' } }),
    ];
    const pts = scatterGroupMeans(scatterData(runs, 'param:x', 'param:y', { groupField: 'param:g' }));
    expect(pts.map((p) => [p.key, p.x, p.y, p.n])).toEqual([
      ['group:A', 2, 15, 2],
      ['group:B', 5, 7, 1],
    ]);
    expect(pts[0]!.sx).toBeCloseTo(Math.SQRT2);
    expect(scatterGroupCsv(pts, 'param:x', 'param:y', 'param:g').split('\n').slice(0, 2)).toEqual([
      'group:config.g,n,mean config.x,std config.x,mean config.y,std config.y',
      `A,2,2,${Math.SQRT2},15,${Math.sqrt(50)}`,
    ]);
  });
});

describe('line data CSV by groups', () => {
  const hist = (rows: string[]) => {
    const h = new MetricsHistory();
    h.ingest(new TextEncoder().encode(rows.join('\n') + '\n'));
    return h;
  };
  it('one row per group and step with the mean and the number of runs', () => {
    const { csv, rows } = lineGroupCsv('loss', [
      { name: 'a', path: '/a', history: hist(['{"step":0,"loss":1}', '{"step":1,"loss":3}']), startedAt: null, group: 'adam' },
      { name: 'b', path: '/b', history: hist(['{"step":0,"loss":3}']), startedAt: null, group: 'adam' },
      { name: 'c', path: '/c', history: hist(['{"step":0,"loss":10}']), startedAt: null, group: 'sgd' },
    ]);
    expect(rows).toBe(3);
    expect(csv.trimEnd().split('\n')).toEqual(['group,step,mean loss,n_runs', 'adam,0,2,2', 'adam,1,3,1', 'sgd,0,10,1']);
  });

  it('the request carries the run -> group map, validated', () => {
    expect(parseWebviewMessage({ type: 'saveLineData', metric: 'loss', runKeys: ['/a'], groups: { '/a': 'adam' } })).toEqual({ type: 'saveLineData', metric: 'loss', runKeys: ['/a'], groups: { '/a': 'adam' } });
    expect(parseWebviewMessage({ type: 'saveLineData', metric: 'loss', runKeys: ['/a'], groups: { '/a': 5 } })).toBeNull();
    expect(parseWebviewMessage({ type: 'saveLineData', metric: 'loss', runKeys: ['/a'] })).toEqual({ type: 'saveLineData', metric: 'loss', runKeys: ['/a'] });
  });
});
