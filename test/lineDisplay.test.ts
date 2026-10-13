// Line chart readability: best-N selection, metric direction, median + IQR band.
import { describe, expect, it } from 'vitest';
import { quantileSorted, spreadSeries } from '../src/model/groupAgg';
import { AUTO_ALL_MAX, effectiveLineMode, lastFinite, metricDirection, parseTopN, resolveDirection, topLineKeys } from '../src/model/lineDisplay';
import type { SeriesPayload } from '../src/types';

const series = (step: number[], y: (number | null)[]): SeriesPayload => ({ runKey: 'r', metric: 'loss', step, epoch: step, wall: step.map((s) => s * 10), y, total: y.length, version: 1 });

describe('metric direction', () => {
  it('lower is better for losses, errors and distances; higher otherwise', () => {
    for (const m of ['train/loss', 'val/error', 'val_err', 'test/perplexity', 'val/ppl', 'mse', 'val/rmse', 'nll', 'asr/wer', 'fid']) expect(metricDirection(m)).toBe('min');
    for (const m of ['val/acc', 'val/auc', 'f1', 'reward', 'sys/gpu_util', 'bleu', 'samples']) expect(metricDirection(m)).toBe('max');
  });
  it('a manual direction overrides the guess', () => {
    expect(resolveDirection('auto', 'loss')).toBe('min');
    expect(resolveDirection('max', 'loss')).toBe('max');
    expect(resolveDirection('min', 'acc')).toBe('min');
  });
});

describe('best N lines', () => {
  const lines = [
    { key: 'a', y: [5, 3, 2] },
    { key: 'b', y: [4, 1, null] }, // final finite value 1
    { key: 'c', y: [null, null] },
    { key: 'd', y: [9, 8, 4] },
  ];
  it('ranks by the final finite value', () => {
    expect(lastFinite([1, 2, null, NaN])).toBe(2);
    expect(lastFinite([null])).toBeNull();
    expect(topLineKeys(lines, 2, 'min')).toEqual(['b', 'a']);
    expect(topLineKeys(lines, 2, 'max')).toEqual(['d', 'a']);
  });
  it('lines without values rank last; n larger than the count returns all', () => {
    expect(topLineKeys(lines, 10, 'min')).toEqual(['b', 'a', 'd', 'c']);
    expect(topLineKeys(lines, 0, 'min')).toEqual([]);
  });
  it('ties keep the given order', () => {
    expect(topLineKeys([{ key: 'x', y: [1] }, { key: 'y', y: [1] }], 1, 'min')).toEqual(['x']);
  });
  it('validates the N input', () => {
    expect(parseTopN(' 10 ')).toBe(10);
    for (const bad of ['0', '101', '2.5', 'abc', '']) expect(parseTopN(bad)).toBeNull();
  });
});

describe('display mode', () => {
  it('auto draws every run up to the limit, then the best N', () => {
    expect(effectiveLineMode('auto', AUTO_ALL_MAX)).toBe('all');
    expect(effectiveLineMode('auto', AUTO_ALL_MAX + 1)).toBe('top');
    expect(effectiveLineMode('spread', 2)).toBe('spread');
    expect(effectiveLineMode('all', 100)).toBe('all');
  });
});

describe('median + interquartile band', () => {
  it('interpolated quantiles', () => {
    expect(quantileSorted([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantileSorted([1, 2, 3, 4], 0.25)).toBe(1.75);
    expect(quantileSorted([7], 0.75)).toBe(7);
  });
  it('per step across runs, with run counts and gaps', () => {
    const s = spreadSeries([series([0, 1], [1, 10]), series([0, 1], [3, null]), series([0], [2])], 'step', false);
    expect(s).toEqual({ x: [0, 1], median: [2, 10], lo: [1.5, 10], hi: [2.5, 10], n: [3, 1] });
    expect(spreadSeries([series([0], [null])], 'step', false)).toEqual({ x: [0], median: [null], lo: [null], hi: [null], n: [0] });
  });
  it('log y leaves out non-positive values', () => {
    expect(spreadSeries([series([0], [-1]), series([0], [4])], 'step', true).median).toEqual([4]);
  });
});
