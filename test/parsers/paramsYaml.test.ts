import { describe, expect, it } from 'vitest';
import { parseParamsYaml } from '../../src/parsers/paramsYaml';
import { fixture } from '../helpers';

describe('parseParamsYaml', () => {
  it('parses flat dotted keys and preserves scalar types', () => {
    const r = parseParamsYaml(fixture('normal-run', 'params.yaml'));
    expect(r.ok && r.value).toEqual({
      'data.batch_size': 64,
      'model.hidden': 128,
      'optim.lr': 0.0003,
      'optim.name': 'adamw',
      'train.amp': true,
      'train.note': null,
    });
  });

  it('flattens legacy nested YAML with dot-separated keys', () => {
    const r = parseParamsYaml(fixture('legacy-run', 'params.yaml'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value['data.batch_size']).toBe(32);
    expect(r.value['data.augment']).toBe(true);
    expect(r.value['optim.lr']).toBe(0.001);
    expect(r.value['optim.sched.name']).toBe('cosine');
    expect(r.value['optim.sched.warmup']).toBe(2);
    expect(r.value['model.layers']).toBe('[128,128]');
  });

  it('reports corrupt YAML without throwing', () => {
    const r = parseParamsYaml(fixture('corrupt-run', 'params.yaml'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^params\.yaml: invalid YAML/);
  });

  it('treats an empty file as no params', () => {
    expect(parseParamsYaml('')).toEqual({ ok: true, value: {}, warnings: [] });
  });

  it('rejects a non-mapping document', () => {
    expect(parseParamsYaml('- a\n- b\n').ok).toBe(false);
  });

  it('parses scientific notation as numbers', () => {
    const r = parseParamsYaml('optim.lr: 1e-05\nx: 3.0e-4\n');
    expect(r.ok && r.value).toEqual({ 'optim.lr': 1e-5, x: 3e-4 });
  });
});
