// "Save data": chart data as plain CSV for agents.
import { describe, expect, it } from 'vitest';
import { barData, boxData, scatterData } from '../src/model/analysis';
import { barCsv, boxCsv, lineCsv, scatterCsv } from '../src/model/plotData';
import { MetricsHistory } from '../src/parsers/metricsJsonl';
import { makeRun } from './helpers';

const best = (value: number) => ({ value, step: 1, epoch: 1, mode: 'max' });
const runs = [
  makeRun({ key: '/r/a', name: 'a', params: { lr: 0.1, data: 'cifar' }, best: { 'val/auc': best(0.9) } }),
  makeRun({ key: '/r/b', name: 'b', params: { lr: 0.01, data: 'cifar' }, best: { 'val/auc': best(0.8) } }),
  makeRun({ key: '/r/c', name: 'c', params: { lr: 0.001, data: 'imagenet' }, best: { 'val/auc': best(0.7) } }),
  makeRun({ key: '/r/d', name: 'd, "quoted"', params: { data: 'imagenet' } }),
];
const lines = (csv: string) => csv.trimEnd().split('\n');

describe('chart data CSV', () => {
  it('bar chart, one bar per run: run, path, group, value', () => {
    const d = barData(runs, 'best:val/auc', { mode: 'runs', groupField: 'param:data', sort: 'desc', limit: Infinity });
    expect(lines(barCsv(d, 'best:val/auc', 'param:data', 'runs'))).toEqual(['run,path,group:config.data,run.best.val/auc', 'a,/r/a,cifar,0.9', 'b,/r/b,cifar,0.8', 'c,/r/c,imagenet,0.7']);
  });

  it('bar chart, group means: group, n, mean, min, max', () => {
    const d = barData(runs, 'best:val/auc', { mode: 'groups', groupField: 'param:data', sort: 'desc', limit: Infinity });
    const out = lines(barCsv(d, 'best:val/auc', 'param:data', 'groups'));
    expect(out[0]).toBe('group:config.data,n,mean run.best.val/auc,min run.best.val/auc,max run.best.val/auc');
    expect(out[1]!.split(',').map((x, i) => (i ? Number(x) : x))).toEqual(['cifar', 2, expect.closeTo(0.85, 9), 0.8, 0.9]);
    expect(out[2]).toBe('imagenet,1,0.7,0.7,0.7');
  });

  it('scatter: one row per plotted run', () => {
    const d = scatterData(runs, 'param:lr', 'best:val/auc', { groupField: 'param:data' });
    expect(lines(scatterCsv(d, 'param:lr', 'best:val/auc', null, 'param:data'))).toEqual([
      'run,path,config.lr,run.best.val/auc,group:config.data',
      'a,/r/a,0.1,0.9,cifar',
      'b,/r/b,0.01,0.8,cifar',
      'c,/r/c,0.001,0.7,imagenet',
    ]);
  });

  it('box: one row per run with its box (group)', () => {
    const csv = boxCsv(boxData(runs, 'best:val/auc', 'param:data'), 'best:val/auc', 'param:data');
    expect(lines(csv)[0]).toBe('group:config.data,run,path,run.best.val/auc');
    expect(lines(csv).slice(1).sort()).toEqual(['cifar,a,/r/a,0.9', 'cifar,b,/r/b,0.8', 'imagenet,c,/r/c,0.7']);
  });

  it('line: the full history of one metric in long format, with gaps kept', () => {
    const h = new MetricsHistory();
    h.ingest(new TextEncoder().encode(['{"step":0,"epoch":0,"time":100,"loss":1.5}', '{"step":0,"epoch":0,"time":101,"acc":0.5}', '{"step":1,"epoch":1,"time":110,"loss":null}', '{"step":2,"epoch":2,"time":120,"loss":0.5}', ''].join('\n')));
    const { csv, rows } = lineCsv('loss', [{ name: 'run "x"', path: '/r/x', history: h, startedAt: 99_000 }]);
    expect(rows).toBe(3);
    expect(lines(csv)).toEqual(['run,path,step,epoch,time_s,loss', '"run ""x""",/r/x,0,0,1,1.5', '"run ""x""",/r/x,1,1,11,', '"run ""x""",/r/x,2,2,21,0.5']);
    expect(lineCsv('nope', [{ name: 'x', path: '/r/x', history: h, startedAt: null }]).rows).toBe(0);
  });
});
