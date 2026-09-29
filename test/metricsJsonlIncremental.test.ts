import { appendFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { JsonlTail, peekJsonlMetricNames } from '../src/parsers/metricsJsonl';
import { tempDir } from './helpers';

const row = (step: number, extra: Record<string, unknown> = {}) => JSON.stringify({ step, epoch: step, time: 1000 + step, loss: 1 / (step + 1), ...extra }) + '\n';

describe('JsonlTail incremental reader', () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = tempDir();
    file = join(dir, 'metrics.jsonl');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads the initial content', async () => {
    writeFileSync(file, row(0) + row(1));
    const t = new JsonlTail(file);
    expect(await t.poll()).toEqual({ changed: true, missing: false });
    expect(t.history.rowCount).toBe(2);
    expect(t.offset).toBe(Buffer.byteLength(row(0) + row(1)));
  });

  it('reads only the appended byte range', async () => {
    writeFileSync(file, row(0));
    const t = new JsonlTail(file);
    await t.poll();
    const offsetBefore = t.offset;
    appendFileSync(file, row(1) + row(2));
    const res = await t.poll();
    expect(res.changed).toBe(true);
    expect(t.history.step).toEqual([0, 1, 2]);
    expect(t.offset).toBe(offsetBefore + Buffer.byteLength(row(1) + row(2)));
  });

  it('reports no change when the file is untouched', async () => {
    writeFileSync(file, row(0));
    const t = new JsonlTail(file);
    await t.poll();
    const v = t.history.version;
    expect(await t.poll()).toEqual({ changed: false, missing: false });
    expect(t.history.version).toBe(v);
  });

  it('holds a partial line and completes it on the next poll', async () => {
    const full = row(1);
    writeFileSync(file, row(0) + full.slice(0, 10));
    const t = new JsonlTail(file);
    await t.poll();
    expect(t.history.rowCount).toBe(1);
    expect(t.history.malformed).toBe(0);
    appendFileSync(file, full.slice(10));
    const res = await t.poll();
    expect(res.changed).toBe(true);
    expect(t.history.step).toEqual([0, 1]);
    expect(t.offset).toBe(Buffer.byteLength(row(0) + full));
  });

  it('resets and rereads from zero when the file shrinks', async () => {
    writeFileSync(file, row(0) + row(1) + row(2));
    const t = new JsonlTail(file);
    await t.poll();
    writeFileSync(file, row(7));
    const res = await t.poll();
    expect(res.changed).toBe(true);
    expect(t.history.step).toEqual([7]);
    expect(t.offset).toBe(Buffer.byteLength(row(7)));
  });

  it('handles truncation to zero', async () => {
    writeFileSync(file, row(0));
    const t = new JsonlTail(file);
    await t.poll();
    truncateSync(file, 0);
    expect((await t.poll()).changed).toBe(true);
    expect(t.history.rowCount).toBe(0);
    expect(t.offset).toBe(0);
  });

  it('counts malformed lines across polls', async () => {
    writeFileSync(file, row(0) + '{"broken\n');
    const t = new JsonlTail(file);
    await t.poll();
    appendFileSync(file, 'garbage\n' + row(1));
    await t.poll();
    expect(t.history.malformed).toBe(2);
    expect(t.history.rowCount).toBe(2);
  });

  it('reports a missing file and recovers when it appears', async () => {
    const t = new JsonlTail(file);
    expect(await t.poll()).toEqual({ changed: false, missing: true });
    writeFileSync(file, row(0));
    expect((await t.poll()).changed).toBe(true);
    rmSync(file);
    expect(await t.poll()).toEqual({ changed: true, missing: true });
    expect(t.history.rowCount).toBe(0);
  });

  it('stops reading at maxBytes and reports truncation', async () => {
    const lines = Array.from({ length: 100 }, (_, i) => row(i)).join('');
    writeFileSync(file, lines);
    const limit = Buffer.byteLength(row(0) + row(1) + row(2)) + 5; // mid-way through row 3
    const t = new JsonlTail(file, limit);
    await t.poll();
    expect(t.truncated).toBe(true);
    expect(t.history.step).toEqual([0, 1, 2]);
    expect(t.offset).toBe(limit);
    appendFileSync(file, row(100));
    expect((await t.poll()).changed).toBe(false); // still capped
    expect(t.history.rowCount).toBe(3);
  });

  it('peeks metric names from the head of the file', async () => {
    writeFileSync(file, row(0) + row(1, { 'val/auc': 0.5 }));
    expect((await peekJsonlMetricNames(file)).sort()).toEqual(['loss', 'val/auc']);
    expect(await peekJsonlMetricNames(join(dir, 'nope.jsonl'))).toEqual([]);
  });

  it('parses a 200k-line file and then only the tail', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 200_000; i++) lines.push(i % 2 ? `{"step": ${i >> 1}, "val/loss": ${i * 1e-6}}` : `{"step": ${i >> 1}, "train/loss": ${i * 1e-6}}`);
    writeFileSync(file, lines.join('\n') + '\n');
    const t = new JsonlTail(file);
    const t0 = performance.now();
    await t.poll();
    const initialMs = performance.now() - t0;
    expect(t.history.rowCount).toBe(200_000);
    appendFileSync(file, row(100_000));
    const t1 = performance.now();
    await t.poll();
    const appendMs = performance.now() - t1;
    expect(t.history.rowCount).toBe(200_001);
    expect(appendMs).toBeLessThan(Math.max(50, initialMs / 5));
  });
});
