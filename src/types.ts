// Shared data types. Must stay free of `vscode` and Node imports: the webview bundles this too.

export const SUPPORTED_SCHEMA_VERSION = 1;

/** Status as written by the logger in run.json (`unknown` for legacy runs without run.json). */
export type RunStatus = 'running' | 'completed' | 'failed' | 'killed' | 'unknown';

/** Status shown in the UI: `stale` is derived from the heartbeat. */
export type DisplayStatus = RunStatus | 'stale';

export const DISPLAY_STATUSES: readonly DisplayStatus[] = ['running', 'stale', 'completed', 'failed', 'killed', 'unknown'];

export type Scalar = string | number | boolean | null;

export interface HostInfo {
  hostname?: string;
  pid?: number;
  user?: string;
  python?: string;
  torch?: string;
  cuda?: string;
  gpus?: string[];
  [key: string]: unknown;
}

export interface GitInfo {
  sha?: string;
  branch?: string;
  dirty?: boolean;
  remote?: string;
  [key: string]: unknown;
}

export interface ExitInfo {
  code: number | null;
  signal: string | null;
  errorType: string | null;
  errorMessage: string | null;
  traceback: string | null;
}

/** Parsed run.json. Unknown keys are dropped; missing keys become null/empty. */
export interface RunMeta {
  schemaVersion: number | null;
  id: string | null;
  name: string | null;
  group: string | null;
  tags: string[];
  notes: string;
  status: RunStatus;
  startedAt: number | null; // epoch ms
  endedAt: number | null;
  heartbeatAt: number | null;
  durationS: number | null;
  exit: ExitInfo | null;
  command: string[] | null;
  cwd: string | null;
  host: HostInfo | null;
  git: GitInfo | null;
}

export interface BestMetric {
  value: number | null;
  step: number | null;
  epoch: number | null;
  mode: string | null;
}

/** Parsed metrics.json. */
export interface MetricsSummary {
  schemaVersion: number | null;
  updatedAt: number | null;
  step: number | null;
  epoch: number | null;
  last: Record<string, number | null>;
  best: Record<string, BestMetric>;
  summary: Record<string, Scalar>;
}

/** One row of the run table. Sent host -> webview; kept small (no config, no metric history). */
export interface RunSummary {
  /** Stable unique key: normalized absolute directory path. */
  key: string;
  id: string;
  name: string;
  group: string | null;
  tags: string[];
  notes: string;
  status: RunStatus;
  displayStatus: DisplayStatus;
  /** false for a running run without heartbeat_at: staleness cannot be judged. */
  heartbeatKnown: boolean;
  startedAt: number | null;
  endedAt: number | null;
  heartbeatAt: number | null;
  durationS: number | null;
  step: number | null;
  epoch: number | null;
  params: Record<string, Scalar>;
  last: Record<string, number | null>;
  best: Record<string, BestMetric>;
  summary: Record<string, Scalar>;
  /** Metric names known without reading metrics.jsonl, plus names from a loaded metrics.jsonl. */
  metricNames: string[];
  /** Human-readable problems: corrupt files, newer schema, malformed metric lines... */
  warnings: string[];
  /** true when the directory has no run.json. */
  legacy: boolean;
  /** Directory path relative to its workspace folder (or absolute if outside), for display. */
  location: string;
}

export const RUN_FILES = ['run.json', 'params.yaml', 'config.json', 'metrics.jsonl', 'metrics.json', 'logs/run.log'] as const;
export type RunFileName = (typeof RUN_FILES)[number];

/** On-demand detail for one run (config can be large, so it is not part of RunSummary). */
export interface RunDetail {
  key: string;
  meta: RunMeta | null;
  config: unknown;
  configError: string | null;
  files: { name: RunFileName; exists: boolean }[];
}

/** One metric series of one run, possibly downsampled. Arrays are index-aligned. */
export interface SeriesPayload {
  runKey: string;
  metric: string;
  step: number[];
  epoch: (number | null)[];
  /** Seconds since started_at (or since the first row when started_at is unknown). */
  wall: (number | null)[];
  y: (number | null)[];
  /** Number of points before downsampling. */
  total: number;
  /** Version of the underlying file state; lets the host skip unchanged resends. */
  version: number;
}

export interface ViewConfig {
  staleAfterSeconds: number;
  refreshIntervalSeconds: number;
  maxPointsPerSeries: number;
}
