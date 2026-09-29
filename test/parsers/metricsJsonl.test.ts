import { describe, expect, it } from 'vitest';
import { MetricsHistory } from '../../src/parsers/metricsJsonl';
import { fixture } from '../helpers';

const enc = (s: string) => new TextEncoder().encode(s);

describe('MetricsHistory (metrics.jsonl parsing)', () => {
  it('parses sparse rows into per-metric columns', () => {
    const h = new MetricsHistory();
    h.ingest(enc(fixture('normal-run', 'metrics.jsonl')));
    expect(h.rowCount).toBe(4);
    expect(h.step).toEqual([0, 0, 1, 1]);
    expect(h.metrics.get('train/loss')).toEqual({ rows: [0, 2], values: [0.9, 0.7] });
    expect(h.metrics.get('val/loss')).toEqual({ rows: [1, 3], values: [0.95, 0.8] });
    expect(h.metricNames().sort()).toEqual(['lr', 'train/loss', 'val/auc', 'val/loss']);
    expect(h.malformed).toBe(0);
  });

  it('keeps null values as gaps (present but null)', () => {
    const h = new MetricsHistory();
    h.ingest(enc(fixture('normal-run', 'metrics.jsonl')));
    expect(h.metrics.get('val/auc')).toEqual({ rows: [1, 3], values: [null, 0.71] });
  });

  it('ignores a partial final line until it is completed', () => {
    const h = new MetricsHistory();
    expect(h.ingest(enc('{"step": 0, "a": 1}\n{"step": 1, "a"'))).toBe(1);
    expect(h.rowCount).toBe(1);
    expect(h.pendingBytes).toBeGreaterThan(0);
    expect(h.malformed).toBe(0);
    expect(h.ingest(enc(': 2}\n'))).toBe(1);
    expect(h.metrics.get('a')?.values).toEqual([1, 2]);
    expect(h.pendingBytes).toBe(0);
  });

  it('counts malformed lines and keeps going', () => {
    const h = new MetricsHistory();
    h.ingest(enc('{"step": 0, "a": 1}\nnot json\n[1,2]\n{"a": 5}\n{"step": 2, "a": 3}\n'));
    expect(h.rowCount).toBe(2);
    expect(h.malformed).toBe(3); // garbage, non-object, missing step/epoch
    expect(h.metrics.get('a')?.values).toEqual([1, 3]);
  });

  it('handles CRLF line endings and blank lines', () => {
    const h = new MetricsHistory();
    h.ingest(enc('{"step": 0, "a": 1}\r\n\r\n{"step": 1, "a": 2}\r\n'));
    expect(h.rowCount).toBe(2);
    expect(h.malformed).toBe(0);
  });

  it('converts Python NaN / Infinity tokens to null', () => {
    const h = new MetricsHistory();
    h.ingest(enc('{"step": 0, "a": NaN, "b": -Infinity, "c": 1}\n'));
    expect(h.malformed).toBe(0);
    expect(h.metrics.get('a')?.values).toEqual([null]);
    expect(h.metrics.get('b')?.values).toEqual([null]);
  });

  it('falls back to epoch when step is missing and ignores non-numeric values', () => {
    const h = new MetricsHistory();
    h.ingest(enc('{"epoch": 4, "a": 1, "phase": "val"}\n'));
    expect(h.step).toEqual([4]);
    expect(h.metrics.has('phase')).toBe(false);
  });

  it('does not split multi-byte UTF-8 characters across chunks', () => {
    const h = new MetricsHistory();
    const bytes = enc('{"step": 0, "métrique/é": 1}\n');
    const cut = bytes.indexOf(0xc3) + 1; // inside the 2-byte "é"
    h.ingest(bytes.subarray(0, cut));
    h.ingest(bytes.subarray(cut));
    expect(h.metricNames()).toEqual(['métrique/é']);
  });
});
