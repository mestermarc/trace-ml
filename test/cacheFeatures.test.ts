// Run index (fast startup), finished-run freezing, starting values, deleted (hidden) runs, PNG export.
import { cpSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listRuns, resolveRunsRoots, type DiscoveredRun } from '../src/discovery';
import { parseHiddenRuns, serializeHiddenRuns } from '../src/model/hiddenRuns';
import { isPng, pngDpi, pngSize, setPngDpi } from '../src/model/png';
import { buildComparison, columnValue, dynamicColumns, valueGroup } from '../src/model/run';
import { normalizePath } from '../src/paths';
import { parseWebviewMessage } from '../src/protocol';
import { RUN_INDEX_VERSION, parseRunIndex, serializeRunIndex } from '../src/runIndex';
import { RunStore } from '../src/runStore';
import { FIXTURES, makeRun, tempDir } from './helpers';

async function discover(ws: string): Promise<DiscoveredRun[]> {
  const res = await resolveRunsRoots([{ name: 'ws', fsPath: ws }], ['runs']);
  const out: DiscoveredRun[] = [];
  for (const r of res.roots) out.push(...(await listRuns(r, new Map())));
  return out.sort((a, b) => a.dirName.localeCompare(b.dirName));
}

const NOW = Date.parse('2026-09-29T13:47:30Z');

describe('RunStore: index, freezing, starting values', () => {
  let ws: string;
  let runsDir: string;
  const store = (finishedCheckEvery = Number.POSITIVE_INFINITY) => new RunStore({ staleAfterSeconds: 60, maxPointsPerSeries: 5000, finishedCheckEvery, maxIdleHistories: 2 });
  const key = (name: string) => normalizePath(join(runsDir, name));

  beforeEach(() => {
    ws = tempDir();
    runsDir = join(ws, 'runs');
    for (const name of ['normal-run', 'legacy-run', 'corrupt-run', 'future-run']) cpSync(join(FIXTURES, name), join(runsDir, name), { recursive: true });
  });
  afterEach(() => rmSync(ws, { recursive: true, force: true }));

  it('reads the starting value (first non-null value) of every metric from the head of metrics.jsonl', async () => {
    const s = store();
    const { upserts } = await s.sync(await discover(ws), { now: NOW });
    const normal = upserts.find((u) => u.key === key('normal-run'))!;
    expect(normal.first).toEqual({ 'train/loss': 0.9, lr: 0.0003, 'val/loss': 0.95, 'val/auc': 0.71 });
    expect(columnValue(normal, 'first:val/loss')).toBe(0.95);
    expect(upserts.find((u) => u.key === key('future-run'))!.first).toEqual({});
  });

  it('does not re-check finished runs on normal polls, only on a forced refresh', async () => {
    const s = store();
    const runs = await discover(ws);
    await s.sync(runs, { now: NOW, force: true });
    const runJson = join(runsDir, 'future-run', 'run.json');
    writeFileSync(runJson, readFileSync(runJson, 'utf-8').replace('"name": "future"', '"name": "renamed"'));
    expect((await s.sync(runs, { now: NOW })).upserts).toEqual([]);
    const forced = await s.sync(runs, { now: NOW, force: true });
    expect(forced.upserts.map((u) => u.name)).toEqual(['renamed']);
  });

  it('round-trips through the run index and starts from it without re-parsing unchanged files', async () => {
    // A whole-second mtime can be restored exactly after the edit below.
    const params = join(runsDir, 'normal-run', 'params.yaml');
    utimesSync(params, 1_700_000_000, 1_700_000_000);
    const a = store();
    await a.sync(await discover(ws), { now: NOW, force: true });
    const text = serializeRunIndex(a.exportIndex());
    const indexed = parseRunIndex(text);
    expect(indexed).toHaveLength(4);

    // Same size, same mtime, different content: a re-parse would see the new value.
    const before = readFileSync(params, 'utf-8');
    writeFileSync(params, before.replace('0.0003', '0.0009'));
    utimesSync(params, 1_700_000_000, 1_700_000_000);
    expect(statSync(params).size).toBe(Buffer.byteLength(before));

    const b = store();
    b.seed(indexed, NOW);
    expect(b.summaries().map((r) => r.key).sort()).toEqual(a.summaries().map((r) => r.key).sort());
    expect(b.summaries().find((r) => r.key === key('normal-run'))!.params['optim.lr']).toBe(0.0003);

    rmSync(join(runsDir, 'legacy-run'), { recursive: true });
    const r = await b.sync(await discover(ws), { now: NOW, force: true });
    expect(r.removed).toEqual([key('legacy-run')]);
    expect(r.upserts).toEqual([]); // nothing changed on disk (stamps match), nothing re-sent
    expect(b.summaries().find((x) => x.key === key('normal-run'))!.params['optim.lr']).toBe(0.0003);
    expect(b.summaries()).toHaveLength(3);
  });

  it('never takes the read location from the index (seeded runs are not "known" until discovered)', async () => {
    const a = store();
    await a.sync(await discover(ws), { now: NOW });
    const b = store();
    b.seed(parseRunIndex(serializeRunIndex(a.exportIndex())), NOW);
    expect(b.knownReal().size).toBe(0);
  });
});

describe('run index validation', () => {
  const good = () => ({
    key: '/w/runs/a',
    dirName: 'a',
    location: 'runs/a',
    runJson: { stamp: { mtimeMs: 1, size: 2 }, value: null, error: null, warnings: [] },
    params: { stamp: null, value: { lr: 0.1, name: 'x', on: true, none: null }, error: null, warnings: [] },
    metrics: { stamp: null, value: null, error: 'metrics.json: invalid JSON', warnings: [] },
    jsonlStamp: null,
    jsonlOutside: false,
    peekedNames: ['loss'],
    first: { loss: 1 },
    headBytes: 10,
  });

  it('keeps valid entries and drops malformed ones', () => {
    const bad1 = { ...good(), key: 5 };
    const bad2 = { ...good(), params: { ...good().params, value: { lr: { nested: 1 } } } };
    const bad3 = { ...good(), runJson: { ...good().runJson, value: { status: 'exploded' } } };
    const bad4 = { ...good(), first: { loss: 'high' } };
    const out = parseRunIndex(JSON.stringify({ version: RUN_INDEX_VERSION, runs: [good(), bad1, bad2, bad3, bad4] }));
    expect(out).toHaveLength(1);
    expect(out[0]!.params.value).toEqual({ lr: 0.1, name: 'x', on: true, none: null });
  });

  it('ignores corrupt files and other versions', () => {
    expect(parseRunIndex('')).toEqual([]);
    expect(parseRunIndex('{nope')).toEqual([]);
    expect(parseRunIndex(JSON.stringify({ version: 99, runs: [good()] }))).toEqual([]);
  });
});

describe('deleted (hidden) runs', () => {
  it('round-trips and skips invalid entries', () => {
    const r = { key: '/w/runs/a', id: 'a', name: 'A', location: 'runs/a', hiddenAt: '2026-10-02T10:00:00.000Z' };
    const text = serializeHiddenRuns([r]);
    expect(parseHiddenRuns(text)).toEqual([r]);
    expect(parseHiddenRuns(JSON.stringify({ runs: [r, { key: 1 }, null, { ...r, key: '/w/runs/b', name: 7 }] }))).toEqual([r]);
    expect(parseHiddenRuns('garbage')).toEqual([]);
    expect(parseHiddenRuns(null)).toEqual([]);
  });

  it('protocol accepts hide / unhide requests with run keys only', () => {
    expect(parseWebviewMessage({ type: 'hideRuns', runKeys: ['/a'] })).toEqual({ type: 'hideRuns', runKeys: ['/a'] });
    expect(parseWebviewMessage({ type: 'unhideRuns', runKeys: ['/a'] })).toEqual({ type: 'unhideRuns', runKeys: ['/a'] });
    expect(parseWebviewMessage({ type: 'hideRuns', runKeys: '/a' })).toBeNull();
    expect(parseWebviewMessage({ type: 'hideRuns', runKeys: [1] })).toBeNull();
  });
});

describe('config / run / summary value groups', () => {
  const run = makeRun({ key: '/r', params: { lr: 0.1 }, first: { loss: 2 }, last: { loss: 0.5 }, best: { loss: { value: 0.4, step: 3, epoch: 3, mode: 'min' } }, summary: { 'test/auc': 0.9 } });

  it('groups column kinds', () => {
    expect(valueGroup('param')).toBe('config');
    expect(valueGroup('first')).toBe('run');
    expect(valueGroup('last')).toBe('run');
    expect(valueGroup('best')).toBe('run');
    expect(valueGroup('summary')).toBe('summary');
    expect(valueGroup('fixed')).toBeNull();
  });

  it('offers start columns and comparison rows for starting values', () => {
    expect(dynamicColumns([run]).map((c) => c.id)).toEqual(['param:lr', 'first:loss', 'last:loss', 'best:loss', 'summary:test/auc']);
    expect(buildComparison([run, run]).metrics.map((r) => r.label)).toEqual(['last loss', 'best loss', 'summary test/auc']);
    expect(buildComparison([run, run], true).metrics.map((r) => r.label)).toEqual(['first loss', 'last loss', 'best loss', 'summary test/auc']);
  });
});

// -- PNG ------------------------------------------------------------------------------

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: number[]): number[] {
  const body = [...type].map((c) => c.charCodeAt(0)).concat(data);
  const len = data.length;
  const crc = crc32(Uint8Array.from(body));
  return [len >>> 24, (len >>> 16) & 255, (len >>> 8) & 255, len & 255, ...body, crc >>> 24, (crc >>> 16) & 255, (crc >>> 8) & 255, crc & 255];
}

/** A structurally valid 3x2 PNG (IDAT content is not decoded by the helpers). */
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ...chunk('IHDR', [0, 0, 0, 3, 0, 0, 0, 2, 8, 6, 0, 0, 0]),
  ...chunk('pHYs', [0, 0, 0x0b, 0x13, 0, 0, 0x0b, 0x13, 1]),
  ...chunk('IDAT', [1, 2, 3]),
  ...chunk('IEND', []),
]);

describe('PNG export helpers', () => {
  it('recognizes PNGs and reads their size', () => {
    expect(isPng(PNG)).toBe(true);
    expect(isPng(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg> padding padding'))).toBe(false);
    expect(pngSize(PNG)).toEqual({ width: 3, height: 2 });
  });

  it('stamps 300 DPI into a single pHYs chunk right after IHDR, with a valid CRC', () => {
    expect(pngDpi(PNG)).toBe(72);
    const out = setPngDpi(PNG);
    expect(pngDpi(out)).toBe(300);
    expect(isPng(out)).toBe(true);
    const types: string[] = [];
    for (let i = 8; i < out.length; ) {
      const len = (out[i]! << 24) | (out[i + 1]! << 16) | (out[i + 2]! << 8) | out[i + 3]!;
      const type = String.fromCharCode(...out.subarray(i + 4, i + 8));
      types.push(type);
      if (type === 'pHYs') {
        const crc = ((out[i + 17]! << 24) | (out[i + 18]! << 16) | (out[i + 19]! << 8) | out[i + 20]!) >>> 0;
        expect(crc).toBe(crc32(out.subarray(i + 4, i + 17)));
      }
      i += 12 + len;
    }
    expect(types).toEqual(['IHDR', 'pHYs', 'IDAT', 'IEND']);
  });

  it('rejects non-PNG data', () => {
    expect(() => setPngDpi(new Uint8Array(40))).toThrow('not a PNG');
  });

  it('protocol accepts only base64 plot data with a short title', () => {
    expect(parseWebviewMessage({ type: 'savePlot', title: 'val/auc', data: 'iVBORw0KGgo=' })).toEqual({ type: 'savePlot', title: 'val/auc', data: 'iVBORw0KGgo=' });
    expect(parseWebviewMessage({ type: 'savePlot', title: 'x', data: 'not base64!' })).toBeNull();
    expect(parseWebviewMessage({ type: 'savePlot', title: 'x'.repeat(500), data: 'AAAA' })).toBeNull();
    expect(parseWebviewMessage({ type: 'savePlot', title: 'x', data: '' })).toBeNull();
  });
});
