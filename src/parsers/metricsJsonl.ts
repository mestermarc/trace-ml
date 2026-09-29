import { promises as fs } from 'node:fs';
import { resolveInside } from '../fsGuard';
import { asFiniteNumber, isRecord, parseJsonLenient } from './util';

const RESERVED = new Set(['step', 'epoch', 'time']);
const NEWLINE = 0x0a;

/** Sparse storage for one metric: the row indices where the key was present, and its values. */
export interface MetricColumn {
  rows: number[];
  values: (number | null)[];
}

/**
 * In-memory metric history built from metrics.jsonl bytes. Pure (no I/O) so it can be tested directly.
 *
 * - Bytes after the last newline are kept as `pending` and parsed once their newline arrives,
 *   so a partial final line is ignored now and retried on the next poll.
 * - Malformed lines are counted and skipped; they never abort parsing.
 * - Storage is column-oriented and sparse: a metric only stores rows where its key appears.
 */
export class MetricsHistory {
  step: number[] = [];
  epoch: (number | null)[] = [];
  time: (number | null)[] = [];
  readonly metrics = new Map<string, MetricColumn>();
  malformed = 0;
  /** Incremented whenever rows are added or the history is reset. */
  version = 0;
  private pending: Buffer = Buffer.alloc(0);
  private readonly decoder = new TextDecoder('utf-8');

  get rowCount(): number {
    return this.step.length;
  }

  get pendingBytes(): number {
    return this.pending.length;
  }

  reset(): void {
    this.step = [];
    this.epoch = [];
    this.time = [];
    this.metrics.clear();
    this.malformed = 0;
    this.pending = Buffer.alloc(0);
    this.version++;
  }

  /** Feeds newly read bytes. Returns the number of rows added. */
  ingest(chunk: Uint8Array): number {
    const buf = this.pending.length ? Buffer.concat([this.pending, chunk]) : Buffer.from(chunk);
    const lastNl = buf.lastIndexOf(NEWLINE);
    if (lastNl < 0) {
      this.pending = buf;
      return 0;
    }
    this.pending = Buffer.from(buf.subarray(lastNl + 1));
    const text = this.decoder.decode(buf.subarray(0, lastNl));
    const before = this.rowCount;
    let start = 0;
    while (start <= text.length) {
      let end = text.indexOf('\n', start);
      if (end < 0) end = text.length;
      this.parseLine(text.slice(start, end));
      start = end + 1;
    }
    const added = this.rowCount - before;
    if (added > 0) this.version++;
    return added;
  }

  private parseLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let row: unknown;
    try {
      row = parseJsonLenient(trimmed);
    } catch {
      this.malformed++;
      return;
    }
    if (!isRecord(row)) {
      this.malformed++;
      return;
    }
    const epoch = asFiniteNumber(row.epoch);
    const step = asFiniteNumber(row.step) ?? epoch;
    if (step === null) {
      this.malformed++;
      return;
    }
    const idx = this.step.length;
    this.step.push(step);
    this.epoch.push(epoch);
    this.time.push(asFiniteNumber(row.time));
    for (const key in row) {
      if (RESERVED.has(key)) continue;
      const v = row[key];
      if (v !== null && typeof v !== 'number') continue; // strings/objects are not plottable metrics
      let col = this.metrics.get(key);
      if (!col) {
        col = { rows: [], values: [] };
        this.metrics.set(key, col);
      }
      col.rows.push(idx);
      col.values.push(asFiniteNumber(v));
    }
  }

  metricNames(): string[] {
    return [...this.metrics.keys()];
  }
}

export interface TailPollResult {
  changed: boolean;
  missing: boolean;
}

const MAX_READ_CHUNK = 8 * 1024 * 1024;

/**
 * Incrementally follows a metrics.jsonl file: only newly appended byte ranges are read.
 * Reading stops at `maxBytes` so a pathological file cannot exhaust the extension host's memory.
 */
export class JsonlTail {
  readonly history = new MetricsHistory();
  /** Bytes consumed from the file (including any pending partial line held in `history`). */
  offset = 0;
  /** True when the file is larger than `maxBytes` and only its beginning was loaded. */
  truncated = false;
  private mtimeMs = -1;
  private loadedOnce = false;

  constructor(
    readonly filePath: string,
    private readonly maxBytes = Number.POSITIVE_INFINITY,
    /** When set, the file must resolve (after symlinks) to a path inside this folder. */
    private readonly allowedReal?: string,
  ) {}

  async poll(): Promise<TailPollResult> {
    let st;
    let path = this.filePath;
    try {
      if (this.allowedReal !== undefined) {
        const r = await resolveInside(this.filePath, this.allowedReal);
        if (!r.ok) throw new Error(r.reason);
        path = r.real;
      }
      st = await fs.stat(path);
    } catch {
      const hadData = this.offset > 0 || this.history.rowCount > 0;
      if (hadData) this.resetState();
      return { changed: hadData, missing: true };
    }
    let changed = false;
    if (st.size < this.offset) {
      // truncated / rewritten: start over
      this.resetState();
      changed = true;
    }
    if (st.size === this.offset && st.mtimeMs === this.mtimeMs && this.loadedOnce) return { changed, missing: false };

    const limit = Math.min(st.size, this.maxBytes);
    this.truncated = st.size > this.maxBytes;
    if (limit <= this.offset) {
      this.mtimeMs = st.mtimeMs;
      this.loadedOnce = true;
      return { changed, missing: false };
    }
    let fh;
    try {
      fh = await fs.open(path, 'r');
    } catch {
      return { changed, missing: true };
    }
    try {
      let remaining = limit - this.offset;
      while (remaining > 0) {
        const len = Math.min(remaining, MAX_READ_CHUNK);
        const buf = Buffer.allocUnsafe(len);
        const { bytesRead } = await fh.read(buf, 0, len, this.offset);
        if (bytesRead <= 0) break;
        this.offset += bytesRead;
        remaining -= bytesRead;
        if (this.history.ingest(buf.subarray(0, bytesRead)) > 0) changed = true;
      }
    } finally {
      await fh.close();
    }
    this.mtimeMs = st.mtimeMs;
    this.loadedOnce = true;
    return { changed, missing: false };
  }

  private resetState(): void {
    this.history.reset();
    this.offset = 0;
    this.mtimeMs = -1;
    this.truncated = false;
  }
}

/**
 * Cheaply discovers metric names from the head of a metrics.jsonl (used only for runs without
 * metrics.json, so the table/picker know about their metrics without loading the full history).
 */
export async function peekJsonlMetricNames(filePath: string, maxBytes = 64 * 1024): Promise<string[]> {
  let fh;
  try {
    fh = await fs.open(filePath, 'r');
  } catch {
    return [];
  }
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fh.read(buf, 0, maxBytes, 0);
    const h = new MetricsHistory();
    h.ingest(buf.subarray(0, bytesRead));
    return h.metricNames();
  } catch {
    return [];
  } finally {
    await fh.close();
  }
}
