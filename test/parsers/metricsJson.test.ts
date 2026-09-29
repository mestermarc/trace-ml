import { describe, expect, it } from 'vitest';
import { parseConfigJson } from '../../src/parsers/configJson';
import { parseMetricsJson } from '../../src/parsers/metricsJson';
import { fixture } from '../helpers';

describe('parseMetricsJson', () => {
  it('parses last / best / summary', () => {
    const r = parseMetricsJson(fixture('normal-run', 'metrics.json'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.step).toBe(1200);
    expect(r.value.epoch).toBe(19);
    expect(r.value.last).toEqual({ 'train/loss': 0.21, 'val/auc': 0.88, lr: 0.000001 });
    expect(r.value.best['val/auc']).toEqual({ value: 0.894, step: 900, epoch: 14, mode: 'max' });
    expect(r.value.summary).toEqual({ 'test/auc': 0.881, 'val/auc_best': 0.894, note: 'ok' });
    expect(r.value.updatedAt).toBe(Date.parse('2026-09-29T14:10:00Z'));
  });

  it('reports malformed JSON', () => {
    const r = parseMetricsJson(fixture('corrupt-run', 'metrics.json'));
    expect(r.ok).toBe(false);
  });

  it('warns on a newer schema version and ignores unknown sections', () => {
    const r = parseMetricsJson(fixture('future-run', 'metrics.json'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings[0]).toMatch(/schema_version 2/);
    expect(r.value.last).toEqual({ 'val/auc': 0.9 });
  });

  it('tolerates missing sections and Python NaN tokens', () => {
    const r = parseMetricsJson('{"step": 3, "last": {"train/loss": NaN, "x": 1}}');
    expect(r.ok && r.value.last).toEqual({ 'train/loss': null, x: 1 });
    expect(r.ok && r.value.best).toEqual({});
    expect(r.ok && r.value.summary).toEqual({});
  });
});

describe('parseConfigJson', () => {
  it('keeps nested structure', () => {
    const r = parseConfigJson(fixture('normal-run', 'config.json'));
    expect(r.ok && r.value).toEqual({
      data: { batch_size: 64, transforms: ['crop', 'flip'] },
      model: { hidden: 128 },
      optim: { lr: 0.0003, name: 'adamw' },
    });
  });

  it('reports invalid config', () => {
    expect(parseConfigJson(fixture('corrupt-run', 'config.json')).ok).toBe(false);
  });
});
