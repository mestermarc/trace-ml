// Content of the TraceML view in the activity bar ("Experiments"): the runs grouped by status, with
// the ones needing attention (running, stale, failed) first. Pure; the host turns it into a tree.
import type { DisplayStatus, RunSummary } from '../types';

export interface ExplorerGroup {
  status: DisplayStatus;
  label: string;
  /** Running / stale / failed groups start expanded; the others collapsed. */
  expanded: boolean;
  runs: RunSummary[];
}

const ORDER: { status: DisplayStatus; label: string; expanded: boolean }[] = [
  { status: 'running', label: 'Running', expanded: true },
  { status: 'stale', label: 'Stale', expanded: true },
  { status: 'failed', label: 'Failed', expanded: true },
  { status: 'completed', label: 'Completed', expanded: false },
  { status: 'killed', label: 'Killed', expanded: false },
  { status: 'unknown', label: 'Unknown', expanded: false },
];

/** Non-empty status groups in attention order; runs newest first. */
export function explorerGroups(runs: readonly RunSummary[]): ExplorerGroup[] {
  return ORDER.flatMap((g) => {
    const rs = runs.filter((r) => r.displayStatus === g.status).sort((a, b) => (b.startedAt ?? -Infinity) - (a.startedAt ?? -Infinity) || a.name.localeCompare(b.name));
    return rs.length ? [{ ...g, runs: rs }] : [];
  });
}

/** Compact age: "now", "5m", "3h", "2d", "6w". */
export function shortAge(ms: number | null, now: number): string {
  if (ms === null) return '';
  const s = Math.max(0, (now - ms) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 14) return `${Math.floor(s / 86400)}d`;
  return `${Math.floor(s / (86400 * 7))}w`;
}

function fmt(v: number): string {
  if (v === 0) return '0';
  const a = Math.abs(v);
  return a >= 1e4 || a < 1e-3 ? v.toExponential(2) : String(Number(v.toPrecision(4)));
}

/** The run's headline value: the first best metric with a value, else the first numeric summary. */
export function keyMetric(run: RunSummary): string | null {
  for (const [k, b] of Object.entries(run.best)) if (b.value !== null) return `${k} ${fmt(b.value)}`;
  for (const [k, v] of Object.entries(run.summary)) if (typeof v === 'number' && Number.isFinite(v)) return `${k} ${fmt(v)}`;
  return null;
}

/** Description shown next to a run name: key metric, step (while running), age. */
export function runDescription(run: RunSummary, now: number): string {
  const parts = [keyMetric(run), run.displayStatus === 'running' && run.step !== null ? `step ${run.step}` : null, shortAge(run.startedAt, now)];
  return parts.filter(Boolean).join(' · ');
}

/** Hover text: name, id, status, group/tags, problems. */
export function runTooltip(run: RunSummary): string {
  return [
    run.name,
    run.id !== run.name ? run.id : null,
    `status: ${run.displayStatus}${run.status !== run.displayStatus ? ` (run.json: ${run.status})` : ''}`,
    run.group ? `group: ${run.group}` : null,
    run.tags.length ? `tags: ${run.tags.join(', ')}` : null,
    keyMetric(run),
    run.warnings.length ? `⚠ ${run.warnings.join('\n⚠ ')}` : null,
    run.location,
  ]
    .filter(Boolean)
    .join('\n');
}
