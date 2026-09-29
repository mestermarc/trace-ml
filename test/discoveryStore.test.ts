import { appendFileSync, cpSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listRuns, resolveRunsRoots, type DiscoveredRun } from '../src/discovery';
import { normalizePath } from '../src/paths';
import { RunStore } from '../src/runStore';
import { FIXTURES, tempDir } from './helpers';

async function discover(ws: string, roots: string[] = ['runs']): Promise<DiscoveredRun[]> {
  const res = await resolveRunsRoots([{ name: 'ws', fsPath: ws }], roots);
  const out: DiscoveredRun[] = [];
  for (const r of res.roots) out.push(...(await listRuns(r, new Map())));
  return out.sort((a, b) => a.dirName.localeCompare(b.dirName));
}

/** Directory symlink that works without admin rights on Windows (junction). */
function linkDir(target: string, path: string): void {
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir');
}

/** File symlinks need extra privileges on Windows; returns false when they cannot be created. */
function tryLinkFile(target: string, path: string): boolean {
  try {
    symlinkSync(target, path, 'file');
    return true;
  } catch {
    return false;
  }
}

describe('discovery (configured runs folders only)', () => {
  let ws: string;
  beforeEach(() => {
    ws = tempDir();
    for (const name of ['normal-run', 'legacy-run', 'corrupt-run', 'future-run']) cpSync(join(FIXTURES, name), join(ws, 'exp', 'runs', name), { recursive: true });
    mkdirSync(join(ws, 'exp', 'runs', 'not-a-run', 'sub'), { recursive: true });
    mkdirSync(join(ws, 'exp', 'runs', '.tmp-run'), { recursive: true });
    writeFileSync(join(ws, 'exp', 'runs', '.tmp-run', 'run.json'), '{}');
    // A runs/ folder elsewhere in the workspace must NOT be picked up unless configured.
    mkdirSync(join(ws, 'other', 'runs', 'x'), { recursive: true });
    writeFileSync(join(ws, 'other', 'runs', 'x', 'run.json'), '{}');
  });
  afterEach(() => rmSync(ws, { recursive: true, force: true }));

  it('uses only the configured folder (workspace-relative), no recursive search', async () => {
    const { roots, problems } = await resolveRunsRoots([{ name: 'ws', fsPath: ws }], ['exp/runs']);
    expect(roots.map((r) => r.label)).toEqual(['exp/runs']);
    expect(roots[0]!.dir).toBe(normalizePath(join(ws, 'exp', 'runs')));
    expect(problems).toEqual([]);
    const runs = await discover(ws, ['exp/runs']);
    expect(runs.map((r) => r.dirName)).toEqual(['corrupt-run', 'future-run', 'legacy-run', 'normal-run']);
    expect(runs[0]!.location).toBe('exp/runs/corrupt-run');
  });

  it('does not find runs folders that are not configured', async () => {
    expect(await discover(ws, ['runs'])).toEqual([]);
    const { problems } = await resolveRunsRoots([{ name: 'ws', fsPath: ws }], ['runs']);
    expect(problems[0]).toMatch(/no runs folder found \(looked for "runs" in the workspace\)/);
  });

  it('accepts ./ prefixes and skips missing defaults silently when another one exists', async () => {
    const { roots, problems } = await resolveRunsRoots([{ name: 'ws', fsPath: ws }], ['./exp/runs', 'traceml/runs']);
    expect(roots.map((r) => r.label)).toEqual(['exp/runs']);
    expect(problems).toEqual([]);
  });

  it('supports absolute runs folders (Windows or POSIX) outside the workspace', async () => {
    const abs = join(ws, 'exp', 'runs');
    const { roots } = await resolveRunsRoots([], [abs]);
    expect(roots.map((r) => r.dir)).toEqual([normalizePath(abs)]);
  });

  it('rejects glob patterns with an explanation', async () => {
    const { roots, problems } = await resolveRunsRoots([{ name: 'ws', fsPath: ws }], ['**/runs']);
    expect(roots).toEqual([]);
    expect(problems[0]).toMatch(/pattern/);
  });

  it('ignores a run directory that is a symlink pointing outside the runs folder', async () => {
    const outside = join(ws, 'secret-run');
    cpSync(join(FIXTURES, 'normal-run'), outside, { recursive: true });
    linkDir(outside, join(ws, 'exp', 'runs', 'escape'));
    const inside = join(ws, 'exp', 'runs', 'normal-run');
    linkDir(inside, join(ws, 'exp', 'runs', 'alias'));
    const names = (await discover(ws, ['exp/runs'])).map((r) => r.dirName);
    expect(names).not.toContain('escape');
    expect(names).toContain('alias'); // symlink staying inside the runs folder is fine
  });
});

describe('RunStore', () => {
  let ws: string;
  let runsDir: string;
  const store = () => new RunStore({ staleAfterSeconds: 60, maxPointsPerSeries: 5000, finishedCheckEvery: 1, maxIdleHistories: 2 });

  beforeEach(() => {
    ws = tempDir();
    runsDir = join(ws, 'runs');
    for (const name of ['normal-run', 'legacy-run', 'corrupt-run', 'future-run']) cpSync(join(FIXTURES, name), join(runsDir, name), { recursive: true });
  });
  afterEach(() => rmSync(ws, { recursive: true, force: true }));

  it('builds summaries for normal, legacy, corrupt and future-schema runs', async () => {
    const s = store();
    const { upserts, removed } = await s.sync(await discover(ws), { now: Date.parse('2026-09-29T13:47:30Z') });
    expect(removed).toEqual([]);
    const by = Object.fromEntries(upserts.map((u) => [u.id === 'future' ? 'future-run' : u.location.split('/').pop()!, u]));

    const normal = upserts.find((u) => u.name === 'mlp-baseline')!;
    expect(normal).toMatchObject({ displayStatus: 'running', group: 'lr-sweep', step: 1200, legacy: false, warnings: [] });
    expect(normal.params['optim.lr']).toBe(0.0003);
    expect(normal.best['val/auc']?.value).toBe(0.894);

    const legacy = by['legacy-run']!;
    expect(legacy).toMatchObject({ id: 'legacy-run', name: 'legacy-run', status: 'unknown', legacy: true });
    expect(legacy.params['optim.sched.name']).toBe('cosine');
    expect(legacy.metricNames).toEqual(['train/loss', 'val/auc']);

    const corrupt = by['corrupt-run']!;
    expect(corrupt.name).toBe('corrupt-run');
    expect(corrupt.warnings.some((w) => w.startsWith('run.json: invalid JSON'))).toBe(true);
    expect(corrupt.warnings.some((w) => w.startsWith('params.yaml: invalid YAML'))).toBe(true);
    expect(corrupt.warnings.some((w) => w.startsWith('metrics.json: invalid JSON'))).toBe(true);

    const future = by['future-run']!;
    expect(future.displayStatus).toBe('completed');
    expect(future.warnings.some((w) => w.includes('schema_version 2'))).toBe(true);
  });

  it('marks a running run stale once the heartbeat is old, without file changes', async () => {
    const s = store();
    const runs = await discover(ws);
    await s.sync(runs, { now: Date.parse('2026-09-29T13:47:30Z') });
    const { upserts } = await s.sync(runs, { now: Date.parse('2026-09-29T13:50:00Z') });
    expect(upserts.find((u) => u.name === 'mlp-baseline')?.displayStatus).toBe('stale');
  });

  it('only reports changed runs and detects new and deleted runs', async () => {
    const s = store();
    const now = Date.parse('2026-09-29T13:47:30Z');
    await s.sync(await discover(ws), { now });
    expect((await s.sync(await discover(ws), { now })).upserts).toEqual([]);

    cpSync(join(FIXTURES, 'future-run'), join(runsDir, 'new-run'), { recursive: true });
    rmSync(join(runsDir, 'legacy-run'), { recursive: true });
    const r = await s.sync(await discover(ws), { now });
    expect(r.upserts.map((u) => u.location)).toEqual(['runs/new-run']);
    expect(r.removed).toEqual([normalizePath(join(runsDir, 'legacy-run'))]);
  });

  it('loads metric history on demand and follows appends', async () => {
    const s = store();
    await s.sync(await discover(ws));
    const key = normalizePath(join(runsDir, 'normal-run'));
    expect(s.getSeries(key, 'train/loss')).toBeNull(); // not loaded at startup
    expect((await s.pollHistory(key)).changed).toBe(true);
    expect(s.getSeries(key, 'train/loss')?.y).toEqual([0.9, 0.7]);
    expect((await s.pollHistory(key)).changed).toBe(false);
    appendFileSync(join(runsDir, 'normal-run', 'metrics.jsonl'), '{"step": 2, "epoch": 2, "time": 1790000004.0, "train/loss": 0.5}\nbroken\n');
    const r = await s.pollHistory(key);
    expect(r.changed).toBe(true);
    expect(r.summary?.warnings).toContain('metrics.jsonl: 1 malformed line skipped');
    expect(s.getSeries(key, 'train/loss')?.y).toEqual([0.9, 0.7, 0.5]);
    expect(s.getSeries(key, 'train/loss')?.wall[0]).toBeCloseTo(1790000000 - Date.parse('2026-09-29T13:46:00Z') / 1000);
  });

  it('loads detail with config and file existence', async () => {
    const s = store();
    await s.sync(await discover(ws));
    const d = await s.loadDetail(normalizePath(join(runsDir, 'normal-run')));
    expect(d?.config).toMatchObject({ model: { hidden: 128 } });
    expect(d?.files.find((f) => f.name === 'logs/run.log')?.exists).toBe(true);
    const c = await s.loadDetail(normalizePath(join(runsDir, 'corrupt-run')));
    expect(c?.configError).toMatch(/config\.json: invalid JSON/);
    const l = await s.loadDetail(normalizePath(join(runsDir, 'legacy-run')));
    expect(l).toMatchObject({ config: null, configError: null, meta: null });
  });

  it('refuses to parse oversized small files (memory guard)', async () => {
    const s = store();
    writeFileSync(join(runsDir, 'normal-run', 'config.json'), Buffer.alloc(17 * 1024 * 1024, 0x20));
    writeFileSync(join(runsDir, 'normal-run', 'params.yaml'), Buffer.alloc(17 * 1024 * 1024, 0x20));
    await s.sync(await discover(ws));
    const key = normalizePath(join(runsDir, 'normal-run'));
    const summary = s.summaries().find((r) => r.key === key)!;
    expect(summary.warnings.some((w) => w.startsWith('params.yaml: file is 17 MB, larger than the 16 MB limit'))).toBe(true);
    expect(summary.params).toEqual({});
    expect((await s.loadDetail(key))?.configError).toMatch(/config\.json is 17 MB/);
  });

  it('never reads a file whose symlink points outside the run folder', async () => {
    const secret = join(ws, 'secret.yaml');
    writeFileSync(secret, 'password: hunter2\n');
    rmSync(join(runsDir, 'normal-run', 'params.yaml'));
    if (!tryLinkFile(secret, join(runsDir, 'normal-run', 'params.yaml'))) return; // no symlink privilege (Windows)
    const s = store();
    await s.sync(await discover(ws));
    const key = normalizePath(join(runsDir, 'normal-run'));
    const summary = s.summaries().find((r) => r.key === key)!;
    expect(summary.params).toEqual({});
    expect(summary.warnings).toContain('params.yaml: symlink points outside the run folder; ignored');
    expect(await s.resolveRunFile(key, 'params.yaml')).toBeNull();
  });

  it('only resolves the fixed run file names for opening', async () => {
    const s = store();
    await s.sync(await discover(ws));
    const key = normalizePath(join(runsDir, 'normal-run'));
    expect(await s.resolveRunFile(key, 'params.yaml')).toMatch(/params\.yaml$/);
    expect(await s.resolveRunFile(key, '../../secret')).toBeNull();
    expect(await s.resolveRunFile(key, 'checkpoints/best.pt')).toBeNull();
    expect(await s.resolveRunFile('not-a-run', 'params.yaml')).toBeNull();
  });

  it('survives a run directory deleted while it is open', async () => {
    const s = store();
    const runs = await discover(ws);
    await s.sync(runs);
    const key = normalizePath(join(runsDir, 'normal-run'));
    await s.pollHistory(key);
    rmSync(join(runsDir, 'normal-run'), { recursive: true });
    const r = await s.sync(runs); // stale discovery list still includes it
    expect(r.upserts.find((u) => u.key === key)?.warnings).toContain('metrics.json and metrics.jsonl are missing');
    expect((await s.pollHistory(key)).changed).toBe(true);
    expect(await s.loadDetail(key)).toMatchObject({ config: null });
    expect((await s.sync(await discover(ws))).removed).toEqual([key]);
  });
});
