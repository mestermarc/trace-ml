// Runs deleted from TraceML ("hidden"): stored in `<cache>/hidden-runs.json`. Deleting only hides a
// run in TraceML; its folder and files are never touched, and it can be restored at any time.
// Pure: no vscode, no I/O.

export const HIDDEN_RUNS_VERSION = 1;

export interface HiddenRun {
  /** Run key (normalized absolute directory). */
  key: string;
  id: string;
  name: string;
  location: string;
  /** ISO-8601 UTC. */
  hiddenAt: string;
}

const MAX_HIDDEN = 100_000;
const str = (v: unknown, max = 4096): v is string => typeof v === 'string' && v.length <= max;

/** Parses the file; invalid entries are skipped, a corrupt file gives an empty list. */
export function parseHiddenRuns(text: string | null): HiddenRun[] {
  if (!text) return [];
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return [];
  }
  const runs = typeof doc === 'object' && doc !== null ? (doc as { runs?: unknown }).runs : undefined;
  if (!Array.isArray(runs)) return [];
  const out = new Map<string, HiddenRun>();
  for (const r of runs.slice(0, MAX_HIDDEN)) {
    if (typeof r !== 'object' || r === null) continue;
    const { key, id, name, location, hiddenAt } = r as Record<string, unknown>;
    if (str(key) && str(id) && str(name) && str(location) && str(hiddenAt, 64)) out.set(key, { key, id, name, location, hiddenAt });
  }
  return [...out.values()];
}

export function serializeHiddenRuns(runs: Iterable<HiddenRun>): string {
  return JSON.stringify({ version: HIDDEN_RUNS_VERSION, note: 'Runs deleted from the TraceML view. Their folders were not modified. Remove an entry (or use Restore in TraceML) to show the run again.', runs: [...runs] }, null, 1) + '\n';
}
