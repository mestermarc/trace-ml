// Grouping by several fields: runs are grouped by the unique combinations of the values.
import { describe, expect, it } from 'vitest';
import { barData, boxData, combinedGroupField, groupFieldParts, groupLabel, groupRuns, NONE_GROUP, scatterData } from '../src/model/analysis';
import { scatterGroupMeans } from '../src/model/groupAgg';
import { fieldHeader } from '../src/model/plotData';
import { makeRun } from './helpers';

const best = (value: number) => ({ value, step: 1, epoch: 1, mode: 'max' });
const runs = [
  makeRun({ key: 'a', name: 'a', group: 'sweep', params: { data: 'cifar', lr: 0.1 }, best: { auc: best(0.9) } }),
  makeRun({ key: 'b', name: 'b', group: 'sweep', params: { data: 'cifar', lr: 0.01 }, best: { auc: best(0.8) } }),
  makeRun({ key: 'c', name: 'c', group: 'sweep', params: { data: 'imagenet', lr: 0.1 }, best: { auc: best(0.7) } }),
  makeRun({ key: 'd', name: 'd', group: 'base', params: { data: 'cifar', lr: 0.1 }, best: { auc: best(0.6) } }),
  makeRun({ key: 'e', name: 'e', params: { lr: 0.1 }, best: { auc: best(0.5) } }),
];
const keys = (rs: { key: string }[]) => rs.map((r) => r.key);

describe('combined group fields', () => {
  it('one field stays itself; none is null; duplicates are dropped', () => {
    expect(combinedGroupField([])).toBeNull();
    expect(combinedGroupField(['group'])).toBe('group');
    expect(combinedGroupField(['group', 'group'])).toBe('group');
    const f = combinedGroupField(['group', 'param:data'])!;
    expect(groupFieldParts(f)).toEqual(['group', 'param:data']);
    expect(groupFieldParts('param:data')).toEqual(['param:data']);
  });

  it('groups by every combination, ordered part by part with (none) last', () => {
    const g = groupRuns(runs, combinedGroupField(['group', 'param:data'])!);
    expect(g.map((x) => [x.label, keys(x.runs)])).toEqual([
      ['base · cifar', ['d']],
      ['sweep · cifar', ['a', 'b']],
      ['sweep · imagenet', ['c']],
      [`${NONE_GROUP} · ${NONE_GROUP}`, ['e']],
    ]);
  });

  it('three fields', () => {
    const f = combinedGroupField(['param:data', 'param:lr', 'group'])!;
    expect(groupRuns(runs, f).map((x) => x.label)).toEqual(['cifar · 0.01 · sweep', 'cifar · 0.1 · base', 'cifar · 0.1 · sweep', 'imagenet · 0.1 · sweep', `${NONE_GROUP} · 0.1 · ${NONE_GROUP}`]);
    expect(groupLabel(runs[0]!, f)).toBe('cifar · 0.1 · sweep');
  });

  it('single-field grouping is unchanged', () => {
    expect(groupRuns(runs, 'group').map((x) => [x.label, keys(x.runs)])).toEqual([
      ['base', ['d']],
      ['sweep', ['a', 'b', 'c']],
      [NONE_GROUP, ['e']],
    ]);
  });

  it('charts and group statistics follow the combined groups', () => {
    const f = combinedGroupField(['group', 'param:data'])!;
    const bars = barData(runs, 'best:auc', { mode: 'groups', groupField: f, sort: 'table' }).bars;
    expect(bars.map((b) => [b.label, b.n])).toEqual([
      ['base · cifar', 1],
      ['sweep · cifar', 2],
      ['sweep · imagenet', 1],
      [`${NONE_GROUP} · ${NONE_GROUP}`, 1],
    ]);
    expect(bars[1]!.value).toBeCloseTo(0.85);
    expect(boxData(runs, 'best:auc', f).boxes.map((b) => b.label)).toEqual(bars.map((b) => b.label));
    const sc = scatterData(runs, 'param:lr', 'best:auc', { groupField: f });
    expect(sc.points.find((p) => p.key === 'a')!.group).toBe('sweep · cifar');
    expect(scatterGroupMeans(sc).find((p) => p.name === 'sweep · cifar')!.y).toBeCloseTo(0.85);
  });

  it('CSV header of a combined field', () => {
    expect(fieldHeader(combinedGroupField(['group', 'param:data'])!)).toBe('group+config.data');
  });
});
