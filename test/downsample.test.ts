import { describe, expect, it } from 'vitest';
import { downsampleIndices, emaSmooth, extractSeries } from '../src/model/metricSeries';
import { MetricsHistory } from '../src/parsers/metricsJsonl';

function noisy(n: number, seed = 1): number[] {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  return Array.from({ length: n }, (_, i) => Math.sin(i / 50) + rnd() * 0.1);
}

describe('downsampleIndices', () => {
  it('returns everything when under the limit', () => {
    expect(downsampleIndices([1, 2, 3], 10)).toEqual([0, 1, 2]);
  });

  it('respects the point budget', () => {
    const y = noisy(200_000);
    const idx = downsampleIndices(y, 5000);
    expect(idx.length).toBeLessThanOrEqual(5000);
    expect(idx.length).toBeGreaterThan(4500);
  });

  it('always keeps the first and final points', () => {
    const y = noisy(10_001);
    const idx = downsampleIndices(y, 500);
    expect(idx[0]).toBe(0);
    expect(idx[idx.length - 1]).toBe(10_000);
  });

  it('retains the global extrema, including single-sample spikes', () => {
    const y = noisy(50_000);
    y[12_345] = 99; // spike
    y[33_333] = -99; // dip
    const idx = downsampleIndices(y, 1000);
    expect(idx).toContain(12_345);
    expect(idx).toContain(33_333);
    const kept = idx.map((i) => y[i]!);
    expect(Math.max(...kept)).toBe(99);
    expect(Math.min(...kept)).toBe(-99);
  });

  it('retains the extrema of every bucket (not every-Nth sampling)', () => {
    const y = Array.from({ length: 1000 }, (_, i) => (i % 7 === 3 ? 10 : i % 11 === 5 ? -10 : 0));
    const idx = downsampleIndices(y, 101);
    const kept = new Set(idx.map((i) => y[i]));
    expect(kept.has(10)).toBe(true);
    expect(kept.has(-10)).toBe(true);
  });

  it('produces strictly increasing indices', () => {
    const idx = downsampleIndices(noisy(20_000), 700);
    for (let i = 1; i < idx.length; i++) expect(idx[i]!).toBeGreaterThan(idx[i - 1]!);
  });

  it('preserves gaps (nulls) inside buckets', () => {
    const y: (number | null)[] = noisy(10_000);
    y[5000] = null;
    const idx = downsampleIndices(y, 300);
    expect(idx.some((i) => y[i] === null)).toBe(true);
  });

  it('keeps the final point even when it is null', () => {
    const y: (number | null)[] = [...noisy(1000), null];
    const idx = downsampleIndices(y, 50);
    expect(idx[idx.length - 1]).toBe(1000);
  });
});

describe('extractSeries', () => {
  it('maps a sparse metric to step/epoch/wall arrays', () => {
    const h = new MetricsHistory();
    h.ingest(
      new TextEncoder().encode(
        '{"step": 0, "epoch": 0, "time": 100, "train/loss": 1}\n{"step": 0, "epoch": 0, "time": 101, "val/loss": 2}\n{"step": 1, "epoch": 1, "time": 110, "train/loss": null}\n',
      ),
    );
    const s = extractSeries(h, 'k', 'train/loss', 95_000, 5000);
    expect(s).toMatchObject({ runKey: 'k', metric: 'train/loss', step: [0, 1], epoch: [0, 1], wall: [5, 15], y: [1, null], total: 2 });
    const missing = extractSeries(h, 'k', 'nope', null, 5000);
    expect(missing.y).toEqual([]);
  });

  it('uses the first row time when started_at is unknown', () => {
    const h = new MetricsHistory();
    h.ingest(new TextEncoder().encode('{"step": 0, "time": 100, "a": 1}\n{"step": 1, "time": 130, "a": 2}\n'));
    expect(extractSeries(h, 'k', 'a', null, 10).wall).toEqual([0, 30]);
  });
});

describe('emaSmooth', () => {
  it('alpha 0 is identity', () => {
    expect(emaSmooth([1, 2, null, 3], 0)).toEqual([1, 2, null, 3]);
  });

  it('is debiased (first value unchanged) and keeps nulls as gaps', () => {
    const s = emaSmooth([10, null, 20], 0.5);
    expect(s[0]).toBeCloseTo(10);
    expect(s[1]).toBeNull();
    expect(s[2]!).toBeGreaterThan(10);
    expect(s[2]!).toBeLessThan(20);
  });
});
