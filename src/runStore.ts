// In-memory cache of parsed runs. Re-reads a file only when its mtime/size changed, and loads a
// run's full metrics.jsonl history only when that run is plotted.
import { promises as fs } from 'node:fs';
import type { DiscoveredRun } from './discovery';
import { extractSeries } from './model/metricSeries';
import { buildRunSummary } from './model/run';
import { parseConfigJson } from './parsers/configJson';
import { parseMetricsJson } from './parsers/metricsJson';
import { resolveInside } from './fsGuard';
import { JsonlTail, peekJsonlMetricNames } from './parsers/metricsJsonl';
import { parseParamsYaml } from './parsers/paramsYaml';
import { parseRunJson } from './parsers/runJson';
import { basename, joinPath } from './paths';
import { RUN_FILES, type MetricsSummary, type RunDetail, type RunMeta, type RunSummary, type Scalar, type SeriesPayload } from './types';

interface Stamp {
  mtimeMs: number;
  size: number;
}

/** Cached parse of one small file (run.json, params.yaml, metrics.json). */
interface Cached<T> {
  stamp: Stamp | null; // null = file missing
  value: T | null;
  error: string | null;
  warnings: string[];
}

/** run.json / params.yaml / metrics.json / config.json larger than this are not parsed (they are small by contract). */
export const MAX_SMALL_FILE_BYTES = 16 * 1024 * 1024;

const empty = <T>(): Cached<T> => ({ stamp: null, value: null, error: null, warnings: [] });

interface RunEntry {
  run: DiscoveredRun;
  runJson: Cached<RunMeta>;
  params: Cached<Record<string, Scalar>>;
  metrics: Cached<MetricsSummary>;
  jsonlStamp: Stamp | null;
  jsonlOutside: boolean;
  peekedNames: string[];
  tail: JsonlTail | null;
  summary: RunSummary | null;
  summaryJson: string;
  /** Poll counter value of the last file check; finished runs are checked less often. */
  lastCheckTick: number;
}

export interface StoreOptions {
  staleAfterSeconds: number;
  maxPointsPerSeries: number;
  /** Finished (completed/failed/killed) runs are re-stat'ed every N polls. */
  finishedCheckEvery: number;
  /** Max number of loaded metric histories kept for runs that are no longer plotted. */
  maxIdleHistories: number;
  /** metrics.jsonl bytes loaded per run at most (protects the extension host's memory). */
  maxMetricsFileBytes?: number;
}

export interface SyncResult {
  upserts: RunSummary[];
  removed: string[];
}

interface GuardedStat {
  stamp: Stamp | null;
  /** Real path to read from (null when missing or outside). */
  real: string | null;
  /** The path is a symlink whose target is outside the allowed folder. */
  outside: boolean;
}

/** stat() confined to `allowedReal`: symlinks leaving the run folder are reported, never followed for reading. */
async function guardedStat(path: string, allowedReal: string): Promise<GuardedStat> {
  const r = await resolveInside(path, allowedReal);
  if (!r.ok) return { stamp: null, real: null, outside: r.reason === 'outside' };
  try {
    const st = await fs.stat(r.real);
    return st.isFile() ? { stamp: { mtimeMs: st.mtimeMs, size: st.size }, real: r.real, outside: false } : { stamp: null, real: null, outside: false };
  } catch {
    return { stamp: null, real: null, outside: false };
  }
}

const outsideMessage = (name: string) => `${name}: symlink points outside the run folder; ignored`;

const sameStamp = (a: Stamp | null, b: Stamp | null) => (a === null ? b === null : b !== null && a.mtimeMs === b.mtimeMs && a.size === b.size);

type Parser<T> = (text: string) => { ok: true; value: T; warnings: string[] } | { ok: false; error: string };

/** Re-parses `file` if its stamp changed. Returns true if the cached state changed. */
async function refreshCached<T>(cache: Cached<T>, path: string, allowedReal: string, parse: Parser<T>): Promise<boolean> {
  const g = await guardedStat(path, allowedReal);
  if (g.outside) {
    const msg = outsideMessage(basename(path));
    if (cache.error === msg && cache.value === null) return false;
    Object.assign(cache, empty<T>(), { error: msg });
    return true;
  }
  const stamp = g.stamp;
  if (sameStamp(stamp, cache.stamp) && !(stamp === null && cache.error)) return false;
  if (stamp === null) {
    Object.assign(cache, empty<T>());
    return true;
  }
  if (stamp.size > MAX_SMALL_FILE_BYTES) {
    Object.assign(cache, empty<T>(), { stamp, error: `${basename(path)}: file is ${Math.round(stamp.size / 1048576)} MB, larger than the 16 MB limit; not parsed` });
    return true;
  }
  let text: string;
  try {
    text = await fs.readFile(g.real!, 'utf-8');
  } catch {
    // disappeared between stat and read: treat as missing, retry next poll
    Object.assign(cache, empty<T>());
    return true;
  }
  cache.stamp = stamp;
  const r = parse(text);
  if (r.ok) {
    cache.value = r.value;
    cache.error = null;
    cache.warnings = r.warnings;
  } else {
    // keep the last good value (a writer may be mid-rename on some filesystems), but surface the error
    cache.error = r.error;
    cache.warnings = [];
  }
  return true;
}

export class RunStore {
  private readonly entries = new Map<string, RunEntry>();
  private tick = 0;
  /** Recently used histories (LRU order) for runs not currently plotted. */
  private readonly idleTails: string[] = [];
  private pinned = new Set<string>();

  constructor(private opts: StoreOptions) {}

  setOptions(opts: Partial<StoreOptions>): void {
    this.opts = { ...this.opts, ...opts };
  }

  keys(): Set<string> {
    return new Set(this.entries.keys());
  }

  /** Run key -> real run directory, for cheap re-discovery. */
  knownReal(): Map<string, string> {
    return new Map([...this.entries].map(([k, e]) => [k, e.run.real]));
  }

  summaries(): RunSummary[] {
    return [...this.entries.values()].flatMap((e) => (e.summary ? [e.summary] : []));
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  dirOf(key: string): string | null {
    return this.entries.get(key)?.run.dir ?? null;
  }

  /**
   * Reconciles with the current discovery result: adds new runs, drops deleted ones, and
   * refreshes changed files. Returns only the summaries that changed.
   */
  async sync(discovered: readonly DiscoveredRun[], opts: { force?: boolean; now?: number } = {}): Promise<SyncResult> {
    this.tick++;
    const now = opts.now ?? Date.now();
    const seen = new Set<string>();
    const upserts: RunSummary[] = [];
    const work: Promise<void>[] = [];

    for (const run of discovered) {
      seen.add(run.key);
      let entry = this.entries.get(run.key);
      if (!entry) {
        entry = {
          run,
          runJson: empty(),
          params: empty(),
          metrics: empty(),
          jsonlStamp: null,
          jsonlOutside: false,
          peekedNames: [],
          tail: null,
          summary: null,
          summaryJson: '',
          lastCheckTick: -Infinity,
        };
        this.entries.set(run.key, entry);
      }
      const e = entry;
      work.push(
        this.refreshEntry(e, now, !!opts.force).then((s) => {
          if (s) upserts.push(s);
        }),
      );
    }
    await Promise.all(work);

    const removed: string[] = [];
    for (const key of [...this.entries.keys()]) {
      if (!seen.has(key)) {
        this.entries.delete(key);
        removed.push(key);
      }
    }
    return { upserts, removed };
  }

  private isFinished(e: RunEntry): boolean {
    const s = e.summary?.status;
    return s === 'completed' || s === 'failed' || s === 'killed';
  }

  /** Returns the new summary if it changed, else null. */
  private async refreshEntry(e: RunEntry, now: number, force: boolean): Promise<RunSummary | null> {
    const due = force || !this.isFinished(e) || this.tick - e.lastCheckTick >= this.opts.finishedCheckEvery;
    if (due) {
      e.lastCheckTick = this.tick;
      const dir = e.run.dir;
      const real = e.run.real;
      const [, , metricsChanged, jsonl] = await Promise.all([
        refreshCached(e.runJson, joinPath(dir, 'run.json'), real, parseRunJson),
        refreshCached(e.params, joinPath(dir, 'params.yaml'), real, parseParamsYaml),
        refreshCached(e.metrics, joinPath(dir, 'metrics.json'), real, parseMetricsJson),
        guardedStat(joinPath(dir, 'metrics.jsonl'), real),
      ]);
      const jsonlStamp = jsonl.stamp;
      e.jsonlOutside = jsonl.outside;
      const jsonlChanged = !sameStamp(jsonlStamp, e.jsonlStamp);
      e.jsonlStamp = jsonlStamp;
      // Without metrics.json, peek at the head of metrics.jsonl so its metric names are known.
      if (!e.metrics.value && jsonl.real && (jsonlChanged || metricsChanged) && e.peekedNames.length === 0) {
        e.peekedNames = await peekJsonlMetricNames(jsonl.real);
      }
      // Loaded histories are advanced by pollHistory() for plotted runs only.
    }
    return this.rebuildSummary(e, now);
  }

  private rebuildSummary(e: RunEntry, now: number): RunSummary | null {
    const warnings: string[] = [];
    for (const c of [e.runJson, e.params, e.metrics]) {
      if (c.error) warnings.push(c.error);
      warnings.push(...c.warnings);
    }
    const hasRunJson = e.runJson.stamp !== null || e.runJson.value !== null;
    if (!hasRunJson && !e.metrics.stamp && !e.jsonlStamp) warnings.push('metrics.json and metrics.jsonl are missing');
    if (e.jsonlOutside) warnings.push(outsideMessage('metrics.jsonl'));
    const h = e.tail?.history;
    if (h && h.malformed > 0) warnings.push(`metrics.jsonl: ${h.malformed} malformed line${h.malformed === 1 ? '' : 's'} skipped`);
    if (e.tail?.truncated) warnings.push(`metrics.jsonl: larger than ${Math.round((this.opts.maxMetricsFileBytes ?? 0) / 1048576)} MB (traceml.maxMetricsFileMB); only the beginning is plotted`);

    const summary = buildRunSummary(
      {
        key: e.run.key,
        dirName: e.run.dirName,
        location: e.run.location,
        meta: e.runJson.value,
        hasRunJson,
        params: e.params.value ?? {},
        metrics: e.metrics.value,
        extraMetricNames: h ? h.metricNames() : e.peekedNames,
        historyStep: h && h.rowCount > 0 ? h.step[h.rowCount - 1]! : null,
        warnings,
      },
      now,
      this.opts.staleAfterSeconds,
    );
    const json = JSON.stringify(summary);
    if (json === e.summaryJson) return null;
    e.summary = summary;
    e.summaryJson = json;
    return summary;
  }

  /** Recomputes summaries whose derived fields depend on settings (e.g. staleAfterSeconds). */
  recomputeAll(now = Date.now()): RunSummary[] {
    return [...this.entries.values()].flatMap((e) => {
      const s = this.rebuildSummary(e, now);
      return s ? [s] : [];
    });
  }

  // -------------------------------------------------------------------------
  // Metric histories
  // -------------------------------------------------------------------------

  /** Marks which runs are currently plotted; other loaded histories are evicted LRU-style. */
  setPinned(keys: Iterable<string>): void {
    const next = new Set(keys);
    for (const k of this.pinned) if (!next.has(k)) this.idleTails.push(k);
    this.pinned = next;
    for (let i = this.idleTails.length - 1; i >= 0; i--) if (next.has(this.idleTails[i]!)) this.idleTails.splice(i, 1);
    while (this.idleTails.length > this.opts.maxIdleHistories) {
      const k = this.idleTails.shift()!;
      const e = this.entries.get(k);
      if (e) e.tail = null;
    }
  }

  /**
   * Loads/updates the metric history of a run incrementally. Returns true if it changed.
   * Also refreshes the run summary (metric names / malformed-line warnings may change).
   */
  async pollHistory(key: string): Promise<{ changed: boolean; summary: RunSummary | null }> {
    const e = this.entries.get(key);
    if (!e) return { changed: false, summary: null };
    let changed = false;
    if (!e.tail) {
      e.tail = new JsonlTail(joinPath(e.run.dir, 'metrics.jsonl'), this.opts.maxMetricsFileBytes, e.run.real);
      changed = true;
    }
    const r = await e.tail.poll();
    changed = changed || r.changed;
    return { changed, summary: changed ? this.rebuildSummary(e, Date.now()) : null };
  }

  historyVersion(key: string): number {
    return this.entries.get(key)?.tail?.history.version ?? -1;
  }

  getSeries(key: string, metric: string): SeriesPayload | null {
    const e = this.entries.get(key);
    if (!e?.tail) return null;
    return extractSeries(e.tail.history, key, metric, e.runJson.value?.startedAt ?? null, this.opts.maxPointsPerSeries);
  }

  // -------------------------------------------------------------------------
  // Detail
  // -------------------------------------------------------------------------

  async loadDetail(key: string): Promise<RunDetail | null> {
    const e = this.entries.get(key);
    if (!e) return null;
    const { dir, real } = e.run;
    let config: unknown = null;
    let configError: string | null = null;
    const cfg = await guardedStat(joinPath(dir, 'config.json'), real);
    if (cfg.outside) configError = outsideMessage('config.json');
    else if (cfg.real && cfg.stamp) {
      if (cfg.stamp.size > MAX_SMALL_FILE_BYTES) {
        configError = `config.json is ${Math.round(cfg.stamp.size / 1048576)} MB, larger than the 16 MB limit; open the file instead`;
      } else {
        try {
          const r = parseConfigJson(await fs.readFile(cfg.real, 'utf-8'));
          if (r.ok) config = r.value;
          else configError = r.error;
        } catch {
          // disappeared between stat and read: treat as missing
        }
      }
    }
    const files = await Promise.all(RUN_FILES.map(async (name) => ({ name, exists: (await guardedStat(joinPath(dir, name), real)).real !== null })));
    return { key, meta: e.runJson.value, config, configError, files };
  }

  /**
   * Real path of one of the fixed run files, only if it exists and is inside the run folder.
   * Used by the "open file" action; anything else returns null.
   */
  async resolveRunFile(key: string, file: string): Promise<string | null> {
    const e = this.entries.get(key);
    if (!e || !(RUN_FILES as readonly string[]).includes(file)) return null;
    return (await guardedStat(joinPath(e.run.dir, file), e.run.real)).real;
  }
}
