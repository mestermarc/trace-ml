// The only place where TraceML writes files: its cache folder (default `<workspace>/traceml/.cache`,
// setting `traceml.cacheDir`). It holds the remembered view, the run index, the list of runs
// deleted from TraceML, table exports (CSV), saved plots (PNG) and exported dashboards (HTML). File names are fixed or checked
// against a strict pattern, never taken from webview input as is; run data is never touched.
import * as vscode from 'vscode';
import { DASHBOARD_NAME } from './dashboardHtml';

/** Older timestamped exports / plots beyond these counts are pruned (latest.csv is always kept). */
export const KEEP_EXPORTS = 20;
export const KEEP_PLOTS = 50;
export const KEEP_DASHBOARDS = 20;
export const LATEST_EXPORT = 'latest.csv';
export const UI_STATE_FILE = 'ui-state.json';
export const RUNS_INDEX_FILE = 'runs-index.json';
export const HIDDEN_RUNS_FILE = 'hidden-runs.json';
export const RUNS_DB_FILE = 'runs.sqlite';
const RUNS_DB_TMP = '.runs.sqlite.tmp';
/** Upper bounds when reading our own files back. */
const MAX_UI_STATE_READ = 1024 * 1024;
const MAX_INDEX_READ = 64 * 1024 * 1024;
const MAX_HIDDEN_READ = 8 * 1024 * 1024;
const MAX_DB_READ = 256 * 1024 * 1024;
export const EXPORT_NAME = /^table-\d{8}-\d{6}\.csv$/;
export const PLOT_NAME = /^plot-[a-z0-9_-]{1,60}-\d{8}-\d{6}(?:-\d{1,3})?\.png$/;
export const PLOT_DATA_NAME = /^plot-[a-z0-9_-]{1,60}-\d{8}-\d{6}(?:-\d{1,3})?\.csv$/;

export class CacheStore {
  private readonly exportsDir: vscode.Uri;
  private readonly plotsDir: vscode.Uri;
  private readonly dashboardsDir: vscode.Uri;

  constructor(readonly dir: vscode.Uri) {
    this.exportsDir = vscode.Uri.joinPath(dir, 'exports');
    this.plotsDir = vscode.Uri.joinPath(dir, 'plots');
    this.dashboardsDir = vscode.Uri.joinPath(dir, 'dashboards');
  }

  // -- exported dashboards -----------------------------------------------------

  /** Writes `dashboards/<name>` (a self-contained HTML snapshot); returns its path. */
  async writeDashboard(name: string, text: string): Promise<vscode.Uri> {
    if (!DASHBOARD_NAME.test(name)) throw new Error(`invalid dashboard file name: ${name}`);
    await vscode.workspace.fs.createDirectory(this.dashboardsDir);
    const file = vscode.Uri.joinPath(this.dashboardsDir, name);
    await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(text));
    await this.prune(this.dashboardsDir, DASHBOARD_NAME, KEEP_DASHBOARDS);
    return file;
  }

  // -- table exports ---------------------------------------------------------

  /** Writes `exports/<name>` and `exports/latest.csv`; returns both paths. */
  async writeExport(name: string, text: string): Promise<{ file: vscode.Uri; latest: vscode.Uri }> {
    if (!EXPORT_NAME.test(name)) throw new Error(`invalid export file name: ${name}`);
    const bytes = new TextEncoder().encode(text);
    await vscode.workspace.fs.createDirectory(this.exportsDir);
    const file = vscode.Uri.joinPath(this.exportsDir, name);
    const latest = vscode.Uri.joinPath(this.exportsDir, LATEST_EXPORT);
    await vscode.workspace.fs.writeFile(file, bytes);
    await vscode.workspace.fs.writeFile(latest, bytes);
    await this.prune(this.exportsDir, EXPORT_NAME, KEEP_EXPORTS);
    return { file, latest };
  }

  // -- plots -------------------------------------------------------------------

  /** Writes `plots/<name>` (a PNG); returns its path. */
  async writePlot(name: string, bytes: Uint8Array): Promise<vscode.Uri> {
    if (!PLOT_NAME.test(name)) throw new Error(`invalid plot file name: ${name}`);
    await vscode.workspace.fs.createDirectory(this.plotsDir);
    const file = vscode.Uri.joinPath(this.plotsDir, name);
    await vscode.workspace.fs.writeFile(file, bytes);
    await this.prune(this.plotsDir, PLOT_NAME, KEEP_PLOTS);
    return file;
  }

  /** Writes `plots/<name>` (a chart's data as CSV); returns its path. */
  async writePlotData(name: string, text: string): Promise<vscode.Uri> {
    if (!PLOT_DATA_NAME.test(name)) throw new Error(`invalid plot data file name: ${name}`);
    await vscode.workspace.fs.createDirectory(this.plotsDir);
    const file = vscode.Uri.joinPath(this.plotsDir, name);
    await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(text));
    await this.prune(this.plotsDir, PLOT_DATA_NAME, KEEP_PLOTS);
    return file;
  }

  /** Keeps the newest `keep` files matching `pattern` (names sort by timestamp); touches nothing else. */
  private async prune(dir: vscode.Uri, pattern: RegExp, keep: number): Promise<void> {
    const entries = await vscode.workspace.fs.readDirectory(dir);
    const stamp = (n: string) => /\d{8}-\d{6}/.exec(n)?.[0] ?? '';
    const old = entries
      .filter(([n, t]) => t === vscode.FileType.File && pattern.test(n))
      .map(([n]) => n)
      .sort((a, b) => stamp(b).localeCompare(stamp(a)) || b.localeCompare(a))
      .slice(keep);
    for (const n of old) await vscode.workspace.fs.delete(vscode.Uri.joinPath(dir, n));
  }

  // -- remembered view, run index, deleted runs -------------------------------------

  async writeUiState(state: unknown): Promise<void> {
    const ui = vscode.Uri.joinPath(this.dir, UI_STATE_FILE);
    await vscode.workspace.fs.createDirectory(this.dir);
    await vscode.workspace.fs.writeFile(ui, new TextEncoder().encode(JSON.stringify(state, null, 1) + '\n'));
  }

  /** The remembered view, or null when missing, too large or unreadable. */
  async readUiState(): Promise<Record<string, unknown> | null> {
    const text = await this.readText(UI_STATE_FILE, MAX_UI_STATE_READ);
    if (text === null) return null;
    try {
      const v = JSON.parse(text);
      return typeof v === 'object' && v !== null && !Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  }

  async writeRunsIndex(text: string): Promise<void> {
    const idx = vscode.Uri.joinPath(this.dir, RUNS_INDEX_FILE);
    await vscode.workspace.fs.createDirectory(this.dir);
    await vscode.workspace.fs.writeFile(idx, new TextEncoder().encode(text));
  }

  readRunsIndex(): Promise<string | null> {
    return this.readText(RUNS_INDEX_FILE, MAX_INDEX_READ);
  }

  /** Writes the run database atomically (temp file, then rename), so readers never see half a file. */
  async writeRunsDb(bytes: Uint8Array): Promise<void> {
    const tmp = vscode.Uri.joinPath(this.dir, RUNS_DB_TMP);
    const db = vscode.Uri.joinPath(this.dir, RUNS_DB_FILE);
    await vscode.workspace.fs.createDirectory(this.dir);
    await vscode.workspace.fs.writeFile(tmp, bytes);
    await vscode.workspace.fs.rename(tmp, db, { overwrite: true });
  }

  /** The run database bytes, or null when missing, too large or unreadable. */
  async readRunsDb(): Promise<Uint8Array | null> {
    try {
      const uri = vscode.Uri.joinPath(this.dir, RUNS_DB_FILE);
      if ((await vscode.workspace.fs.stat(uri)).size > MAX_DB_READ) return null;
      return await vscode.workspace.fs.readFile(uri);
    } catch {
      return null;
    }
  }

  async writeHiddenRuns(text: string): Promise<void> {
    const hidden = vscode.Uri.joinPath(this.dir, HIDDEN_RUNS_FILE);
    await vscode.workspace.fs.createDirectory(this.dir);
    await vscode.workspace.fs.writeFile(hidden, new TextEncoder().encode(text));
  }

  readHiddenRuns(): Promise<string | null> {
    return this.readText(HIDDEN_RUNS_FILE, MAX_HIDDEN_READ);
  }

  /** One of our fixed-name files, or null when missing, larger than `max` or unreadable. */
  private async readText(name: string, max: number): Promise<string | null> {
    try {
      const uri = vscode.Uri.joinPath(this.dir, name);
      const st = await vscode.workspace.fs.stat(uri);
      if (st.size > max) return null;
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    } catch {
      return null;
    }
  }
}
