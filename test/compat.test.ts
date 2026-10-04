// Upgrade safety: a project set up with an older TraceML (0.1.9 - 0.1.17) keeps working.
// Runs are found in the same place, old cache files are ignored or migrated, never in the way.
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listRuns, resolveRunsRoots } from '../src/discovery';
import { parseHiddenRuns } from '../src/model/hiddenRuns';
import { parseRunIndex, serializeRunIndex } from '../src/runIndex';
import { RunStore } from '../src/runStore';
import { FIXTURES, tempDir } from './helpers';

/** A workspace as an older version left it: runs in traceml/runs, old files in traceml/.cache. */
function oldProject(): string {
  const ws = tempDir();
  for (const name of ['normal-run', 'legacy-run', 'corrupt-run', 'future-run']) cpSync(join(FIXTURES, name), join(ws, 'traceml', 'runs', name), { recursive: true });
  const cache = join(ws, 'traceml', '.cache');
  mkdirSync(join(cache, 'exports'), { recursive: true });
  // 0.1.9 - 0.1.16: JSON exports and the remembered view
  writeFileSync(join(cache, 'exports', 'latest.json'), JSON.stringify({ format: 'traceml.table-export', version: 1, rows: [] }));
  writeFileSync(join(cache, 'exports', 'table-20261001-120000.json'), '{}');
  writeFileSync(join(cache, 'ui-state.json'), JSON.stringify({ version: 1, sort: [{ col: 'started', dir: 'desc' }], filters: { search: '', statuses: [], columns: { 'param:optim.name': 'adam' } }, maxRows: 100 }));
  return ws;
}

const store = () => new RunStore({ staleAfterSeconds: 60, maxPointsPerSeries: 5000, finishedCheckEvery: Infinity, maxIdleHistories: 2 });

describe('upgrading from an older TraceML', () => {
  it('finds every run with the default runs folder, exactly as before', async () => {
    const ws = oldProject();
    const { roots, problems } = await resolveRunsRoots([{ name: 'proj', fsPath: ws }], ['./traceml/runs']);
    expect(problems).toEqual([]);
    const runs = (await Promise.all(roots.map((r) => listRuns(r, new Map())))).flat();
    expect(runs.map((r) => r.dirName).sort()).toEqual(['corrupt-run', 'future-run', 'legacy-run', 'normal-run']);
    const { upserts } = await store().sync(runs, { force: true });
    expect(upserts).toHaveLength(4);
    // legacy run (no run.json / metrics.json, as very old loggers wrote) still has its config and metrics
    const legacy = upserts.find((u) => u.location.endsWith('legacy-run'))!;
    expect(legacy.legacy).toBe(true);
    expect(legacy.metricNames).toEqual(['train/loss', 'val/auc']);
    expect(Object.keys(legacy.params).length).toBeGreaterThan(0);
  });

  it('the old cache files are not mistaken for runs and do not need migration', async () => {
    const ws = oldProject();
    const { roots } = await resolveRunsRoots([{ name: 'proj', fsPath: ws }], ['./traceml/runs']);
    const runs = (await Promise.all(roots.map((r) => listRuns(r, new Map())))).flat();
    expect(runs.some((r) => r.dir.includes('.cache'))).toBe(false);
    // files that did not exist before simply start empty
    expect(parseHiddenRuns(null)).toEqual([]);
    expect(parseRunIndex('')).toEqual([]);
  });

  it('a 0.1.17 runs-index.json is still read once (migrated into the run database)', async () => {
    const ws = oldProject();
    const { roots } = await resolveRunsRoots([{ name: 'proj', fsPath: ws }], ['./traceml/runs']);
    const runs = (await Promise.all(roots.map((r) => listRuns(r, new Map())))).flat();
    const a = store();
    await a.sync(runs, { force: true });
    const migrated = parseRunIndex(serializeRunIndex(a.exportIndex()));
    expect(migrated).toHaveLength(4);
    const b = store();
    b.seed(migrated);
    expect((await b.sync(runs, { force: true })).removed).toEqual([]);
    expect(b.summaries()).toHaveLength(4);
  });
});
