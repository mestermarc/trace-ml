// Dev-only benchmark of the host-side pipeline (discovery + parse + incremental polling).
//   python scripts/fake_runs.py --runs 1000 --output test-data/perf/runs --big-run-lines 200000
//   npm run bench -- test-data/perf
import { resolve } from 'node:path';
import { listRuns, resolveRunsRoots } from '../src/discovery';
import { RunStore } from '../src/runStore';

async function main(): Promise<void> {
  const ws = resolve(process.argv[2] ?? 'test-data');
  const store = new RunStore({ staleAfterSeconds: 60, maxPointsPerSeries: 5000, finishedCheckEvery: 6, maxIdleHistories: 8 });
  const time = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = performance.now();
    const r = await fn();
    console.log(`${label.padEnd(44)} ${(performance.now() - t0).toFixed(1).padStart(8)} ms`);
    return r;
  };

  const { roots } = await time('resolve runs folder', () => resolveRunsRoots([], [/[\\/]runs$/.test(ws) ? ws : resolve(ws, 'runs')]));
  const runs = await time('list runs (cold)', async () => (await Promise.all(roots.map((r) => listRuns(r, new Map())))).flat());
  console.log(`  ${runs.length} runs`);
  const first = await time('initial sync (parse run/params/metrics.json)', () => store.sync(runs));
  console.log(`  ${first.upserts.length} summaries, ${JSON.stringify(first.upserts).length} bytes as JSON`);
  await time('list runs (warm)', async () => (await Promise.all(roots.map((r) => listRuns(r, store.knownReal())))).flat());
  const again = await time('steady-state sync (nothing changed)', () => store.sync(runs));
  console.log(`  ${again.upserts.length} changed`);

  const big = store.summaries().sort((a, b) => (b.step ?? 0) - (a.step ?? 0))[0];
  if (big) {
    await time(`load history of ${big.name}`, () => store.pollHistory(big.key));
    await time('poll history again (unchanged)', () => store.pollHistory(big.key));
    const s = await time('extract + downsample train/loss', async () => store.getSeries(big.key, 'train/loss'));
    console.log(`  ${s?.total} points -> ${s?.y.length} sent`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
