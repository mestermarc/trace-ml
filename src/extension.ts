import * as vscode from 'vscode';
import { listRuns, resolveRunsRoots, type DiscoveredRun, type RunsRoot } from './discovery';
import { DEFAULT_CACHE_DIR, resolveCacheDirPath } from './cacheDir';
import { CacheStore } from './cacheStore';
import { parseHiddenRuns, serializeHiddenRuns, type HiddenRun } from './model/hiddenRuns';
import { MAX_PNG_BYTES, isPng, pngSize, setPngDpi } from './model/png';
import { buildTableExport, exportFileName, plotFileName, serializeTableCsv } from './model/tableExport';
import { READONLY_SCHEME, ReadonlyRunFiles } from './readonlyFs';
import { joinPath, relativePath } from './paths';
import { parseRunIndex, serializeRunIndex } from './runIndex';
import { Poller } from './poller';
import { parseWebviewMessage, type ExportRequest, type HostToWebview, type WebviewToHost } from './protocol';
import { RunStore } from './runStore';
import type { RunSummary, SeriesPayload, ViewConfig } from './types';

const VIEW_TYPE = 'traceml.experiments';
/** Where versions <= 0.1.8 remembered the view (read once as a fallback, never written). */
const LEGACY_UI_STATE_KEY = 'traceml.uiState';
const SERIES_PER_MESSAGE = 16;
/** The run index is rewritten at most this often while runs change (e.g. during training). */
const INDEX_SAVE_DELAY_MS = 10_000;

/** True when `key` is a direct sub-folder of the runs folder `rootDir`. */
function isRunOf(rootDir: string, key: string): boolean {
  const rel = relativePath(rootDir, key);
  return rel !== null && rel !== '' && !rel.includes('/');
}

interface Settings extends ViewConfig {
  roots: string[];
  maxMetricsFileMB: number;
  cacheDir: string;
}

function readSettings(): Settings {
  const c = vscode.workspace.getConfiguration('traceml');
  const num = (key: string, def: number, min: number) => {
    const v = c.get<number>(key, def);
    return typeof v === 'number' && Number.isFinite(v) ? Math.max(min, v) : def;
  };
  return {
    roots: c.get<string[]>('roots', ['./traceml/runs']),
    refreshIntervalSeconds: num('refreshIntervalSeconds', 5, 1),
    staleAfterSeconds: num('staleAfterSeconds', 60, 1),
    maxPointsPerSeries: Math.floor(num('maxPointsPerSeries', 5000, 100)),
    maxMetricsFileMB: num('maxMetricsFileMB', 64, 1),
    cacheDir: c.get<string>('cacheDir', DEFAULT_CACHE_DIR),
  };
}

function nonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 32; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

class TraceMLController implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private panelDisposables: vscode.Disposable[] = [];
  private settings = readSettings();
  private readonly store: RunStore;
  private readonly poller: Poller;
  private roots: RunsRoot[] = [];
  private rootProblems: string[] = [];
  private rootsKey = '';
  /** Time of the last completed scan (0 = none yet). */
  private lastRefreshedAt = 0;
  private forceNext = true;
  private webviewReady = false;
  private subscription: { runKeys: string[]; metrics: string[] } = { runKeys: [], metrics: [] };
  /** `${runKey}\0${metric}` -> history version last sent to the webview. */
  private readonly sent = new Map<string, number>();
  private readonly output = vscode.window.createOutputChannel('TraceML');
  private readonly disposables: vscode.Disposable[] = [];
  private readonly readonlyFiles = new ReadonlyRunFiles();
  private lastExport: { file: string; latest: string } | null = null;
  private lastPlot: string | null = null;
  /** Runs deleted from TraceML (hidden; never discovered or read again until restored). */
  private hidden = new Map<string, HiddenRun>();
  /** The run index and the hidden-runs list are read once, on the first scan. */
  private cacheLoaded = false;
  private indexTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.store = new RunStore({
      staleAfterSeconds: this.settings.staleAfterSeconds,
      maxPointsPerSeries: this.settings.maxPointsPerSeries,
      // Finished runs are not re-checked on polls, only on a forced refresh (Refresh button,
      // panel opened, settings changed): their files no longer change.
      finishedCheckEvery: Number.POSITIVE_INFINITY,
      maxIdleHistories: 8,
      maxMetricsFileBytes: this.settings.maxMetricsFileMB * 1024 * 1024,
    });
    this.poller = new Poller(
      () => this.tick(),
      () => this.settings.refreshIntervalSeconds * 1000,
      (e) => this.reportError('Refresh failed', e),
    );
    this.disposables.push(
      vscode.workspace.registerFileSystemProvider(READONLY_SCHEME, this.readonlyFiles, { isReadonly: true, isCaseSensitive: process.platform !== 'win32' }),
      this.output,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('traceml')) this.onSettingsChanged();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
    );
  }

  show(preserveFocus = false): void {
    if (this.panel) {
      this.panel.reveal(undefined, preserveFocus);
      return;
    }
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'TraceML', { viewColumn: vscode.ViewColumn.Active, preserveFocus }, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'dist'), vscode.Uri.joinPath(this.ctx.extensionUri, 'media')],
    });
    void this.attach(panel);
  }

  /**
   * TraceML's cache folder (`traceml.cacheDir`, default `<workspace>/traceml/.cache`): remembered
   * view + table exports. Falls back to VS Code's extension storage when no folder is open.
   */
  private cache(): CacheStore {
    const folders = (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => f.uri.fsPath);
    const path = resolveCacheDirPath(this.settings.cacheDir, folders);
    return new CacheStore(path ? vscode.Uri.file(path) : vscode.Uri.joinPath(this.ctx.globalStorageUri, 'cache'));
  }

  /** Attaches a new or restored (after window reload) panel. */
  async attach(panel: vscode.WebviewPanel): Promise<void> {
    this.panel = panel;
    this.webviewReady = false;
    // Tab icon: small line icon (light grey, readable on tab bars); the logo is media/curly_m.svg.
    panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'activity.svg');
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'dist'), vscode.Uri.joinPath(this.ctx.extensionUri, 'media')],
    };
    const remembered = (await this.cache().readUiState()) ?? this.ctx.workspaceState.get(LEGACY_UI_STATE_KEY) ?? null;
    panel.webview.html = this.html(panel.webview, remembered);
    this.panelDisposables.push(
      panel.webview.onDidReceiveMessage((m) => void this.onMessage(m)),
      panel.onDidDispose(() => this.onPanelDisposed()),
      // Poll only while the panel is visible: a background tab causes no filesystem reads.
      panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.visible) {
          this.poller.start();
        } else {
          this.poller.stop();
        }
      }),
    );
    this.forceNext = true;
    if (panel.visible) this.poller.start();
  }

  refresh(): void {
    if (!this.panel) {
      this.show();
      return;
    }
    this.forceNext = true;
    if (!this.panel.visible) {
      this.panel.reveal(); // becoming visible restarts polling with a full refresh
      return;
    }
    this.poller.trigger();
  }

  private onPanelDisposed(): void {
    this.poller.stop();
    this.panel = undefined;
    this.webviewReady = false;
    this.panelDisposables.forEach((d) => d.dispose());
    this.panelDisposables = [];
    this.subscription = { runKeys: [], metrics: [] };
    this.sent.clear();
    this.store.setPinned([]);
  }

  private onSettingsChanged(): void {
    const prev = this.settings;
    this.settings = readSettings();
    this.store.setOptions({
      staleAfterSeconds: this.settings.staleAfterSeconds,
      maxPointsPerSeries: this.settings.maxPointsPerSeries,
      maxMetricsFileBytes: this.settings.maxMetricsFileMB * 1024 * 1024,
    });
    if (prev.maxPointsPerSeries !== this.settings.maxPointsPerSeries) this.sent.clear();
    this.store.recomputeAll();
    if (this.webviewReady) this.sendSnapshot();
    this.refresh();
  }

  private post(msg: HostToWebview): void {
    if (this.panel && this.webviewReady) void this.panel.webview.postMessage(msg);
  }

  private viewConfig(): ViewConfig {
    const { staleAfterSeconds, refreshIntervalSeconds, maxPointsPerSeries } = this.settings;
    return { staleAfterSeconds, refreshIntervalSeconds, maxPointsPerSeries };
  }

  private rootLabels(): string[] {
    const labels = this.roots.map((r) => r.label);
    return labels;
  }

  private sendSnapshot(): void {
    this.post({
      type: 'runsSnapshot',
      runs: this.store.summaries(),
      refreshedAt: this.lastRefreshedAt,
      config: this.viewConfig(),
      roots: this.rootLabels(),
      scanned: this.lastRefreshedAt > 0,
    });
    if (this.cacheLoaded) this.post({ type: 'hiddenRuns', runs: [...this.hidden.values()] });
  }

  /**
   * First scan only: reads the hidden-runs list and the run index from the cache folder, and fills
   * the table from the index right away (entries outside the current runs folders are ignored).
   */
  private async loadCache(): Promise<void> {
    this.cacheLoaded = true;
    const cache = this.cache();
    this.hidden = new Map(parseHiddenRuns(await cache.readHiddenRuns()).map((r) => [r.key, r]));
    const indexed = parseRunIndex((await cache.readRunsIndex()) ?? '').filter((r) => !this.hidden.has(r.key) && this.roots.some((root) => isRunOf(root.dir, r.key)));
    this.store.seed(indexed);
    if (indexed.length) this.output.appendLine(`Loaded ${indexed.length} runs from the run index`);
    this.sendSnapshot();
  }

  /** Saves the run index soon (debounced: at most once per INDEX_SAVE_DELAY_MS). */
  private scheduleIndexSave(): void {
    if (this.indexTimer) return;
    this.indexTimer = setTimeout(() => {
      this.indexTimer = undefined;
      void this.cache()
        .writeRunsIndex(serializeRunIndex(this.store.exportIndex()))
        .catch((e) => this.output.appendLine(`Could not save the run index: ${e instanceof Error ? e.message : String(e)}`));
    }, INDEX_SAVE_DELAY_MS);
  }

  private async saveHidden(): Promise<void> {
    await this.cache().writeHiddenRuns(serializeHiddenRuns(this.hidden.values()));
    this.post({ type: 'hiddenRuns', runs: [...this.hidden.values()] });
  }

  /** Deletes runs from TraceML: they are hidden and no longer read. Their folders are not touched. */
  private async hideRuns(keys: string[]): Promise<void> {
    const byKey = new Map(this.store.summaries().map((r) => [r.key, r]));
    const hiddenAt = new Date().toISOString();
    const added: string[] = [];
    for (const key of keys) {
      const r = byKey.get(key);
      if (!r || this.hidden.has(key)) continue;
      this.hidden.set(key, { key, id: r.id, name: r.name, location: r.location, hiddenAt });
      added.push(key);
    }
    if (!added.length) return;
    await this.saveHidden();
    this.output.appendLine(`Deleted ${added.length} run${added.length === 1 ? '' : 's'} from TraceML (folders not modified)`);
    this.post({ type: 'runsPatch', upserts: [], removed: added, refreshedAt: Date.now() });
    this.poller.trigger();
  }

  private async unhideRuns(keys: string[]): Promise<void> {
    let n = 0;
    for (const key of keys) if (this.hidden.delete(key)) n++;
    if (!n) return;
    await this.saveHidden();
    this.poller.trigger();
  }

  // ---------------------------------------------------------------------------
  // Polling
  // ---------------------------------------------------------------------------

  private async tick(): Promise<void> {
    const force = this.forceNext;
    this.forceNext = false;
    // Only the configured runs folders are looked at: no workspace-wide search.
    const folders = (vscode.workspace.workspaceFolders ?? [])
      .filter((f) => f.uri.scheme === 'file')
      .map((f) => ({ name: f.name, fsPath: f.uri.fsPath }));
    const res = await resolveRunsRoots(folders, this.settings.roots);
    this.roots = res.roots;
    if (!this.cacheLoaded) await this.loadCache();
    const rootsKey = JSON.stringify([res.roots, res.problems]);
    const rootsChanged = force || rootsKey !== this.rootsKey;
    this.rootsKey = rootsKey;
    if (rootsChanged && res.problems.join() !== this.rootProblems.join()) {
      this.rootProblems = res.problems;
      if (res.problems.length) {
        this.output.appendLine(res.problems.join('\n'));
        this.post({ type: 'error', message: res.problems.join(' · ') });
      }
    }

    const known = this.store.knownReal();
    const discovered: DiscoveredRun[] = [];
    const seen = new Set<string>();
    for (const root of this.roots) {
      for (const run of await listRuns(root, known)) {
        if (this.hidden.has(run.key)) continue;
        if (!seen.has(run.key)) {
          seen.add(run.key);
          discovered.push(run);
        }
      }
    }

    const { upserts, removed } = await this.store.sync(discovered, { force });
    if (upserts.length || removed.length || force) this.scheduleIndexSave();
    const byKey = new Map<string, RunSummary>(upserts.map((u) => [u.key, u]));

    // Advance metric histories of plotted runs only.
    const changedRuns: string[] = [];
    for (const key of this.subscription.runKeys) {
      const r = await this.store.pollHistory(key);
      if (r.summary) byKey.set(key, r.summary);
      if (r.changed) changedRuns.push(key);
    }

    this.lastRefreshedAt = Date.now();
    if (!this.webviewReady) return;
    this.post({ type: 'runsPatch', upserts: [...byKey.values()], removed, refreshedAt: this.lastRefreshedAt, roots: rootsChanged ? this.rootLabels() : undefined });
    if (changedRuns.length) this.sendSeries(changedRuns);
  }

  /** Sends series for the given runs (x subscribed metrics) whose history version changed since last sent. */
  private sendSeries(runKeys: readonly string[]): void {
    const out: SeriesPayload[] = [];
    for (const key of runKeys) {
      const version = this.store.historyVersion(key);
      for (const metric of this.subscription.metrics) {
        const id = `${key}\0${metric}`;
        if (this.sent.get(id) === version) continue;
        const s = this.store.getSeries(key, metric);
        if (!s) continue;
        this.sent.set(id, version);
        out.push(s);
      }
    }
    for (let i = 0; i < out.length; i += SERIES_PER_MESSAGE) this.post({ type: 'series', series: out.slice(i, i + SERIES_PER_MESSAGE) });
  }

  // ---------------------------------------------------------------------------
  // Webview messages
  // ---------------------------------------------------------------------------

  private async onMessage(raw: unknown): Promise<void> {
    const msg: WebviewToHost | null = parseWebviewMessage(raw);
    if (!msg) {
      this.output.appendLine(`Ignored invalid webview message: ${JSON.stringify(raw)?.slice(0, 200)}`);
      return;
    }
    try {
      switch (msg.type) {
        case 'ready':
          this.webviewReady = true;
          this.sent.clear();
          this.sendSnapshot();
          this.refresh();
          break;
        case 'refreshNow':
          this.refresh();
          break;
        case 'saveState':
          // Remembered view: <cache>/ui-state.json (fixed name, settings only, no run data).
          await this.cache()
            .writeUiState(msg.state)
            .catch((e) => this.output.appendLine(`Could not save the view state: ${e instanceof Error ? e.message : String(e)}`));
          break;
        case 'exportTable':
          await this.exportTable(msg.request);
          break;
        case 'copyExportPath':
          if (this.lastExport) {
            await vscode.env.clipboard.writeText(this.lastExport.file);
            vscode.window.setStatusBarMessage('TraceML: export path copied', 3000);
          }
          break;
        case 'openExport':
          if (this.lastExport) await vscode.commands.executeCommand('vscode.open', this.readonlyFiles.uriFor(this.lastExport.file), { preview: true });
          break;
        case 'hideRuns':
          await this.hideRuns(msg.runKeys);
          break;
        case 'unhideRuns':
          await this.unhideRuns(msg.runKeys);
          break;
        case 'savePlot':
          await this.savePlot(msg.title, msg.data);
          break;
        case 'copyPlotPath':
          if (this.lastPlot) {
            await vscode.env.clipboard.writeText(this.lastPlot);
            vscode.window.setStatusBarMessage('TraceML: plot path copied', 3000);
          }
          break;
        case 'openPlot':
          if (this.lastPlot) await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(this.lastPlot), { preview: true });
          break;
        case 'openSettings':
          await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:traceml.traceml');
          break;
        case 'requestSeries':
          await this.onRequestSeries(msg.runKeys, msg.metrics);
          break;
        case 'requestDetail': {
          const detail = await this.store.loadDetail(msg.runKey);
          if (detail) this.post({ type: 'runDetail', detail });
          break;
        }
        case 'openFile':
          await this.openFile(msg.runKey, msg.file);
          break;
      }
    } catch (e) {
      this.reportError(`Failed to handle ${msg.type}`, e);
    }
  }

  private async onRequestSeries(runKeys: string[], metrics: string[]): Promise<void> {
    // Keys may not be known yet (e.g. restored selection before the first scan); the tick picks them up.
    const keys = [...new Set(runKeys)];
    this.subscription = { runKeys: keys, metrics: [...new Set(metrics)] };
    this.store.setPinned(keys);
    // Forget what was sent for pairs no longer plotted, so re-adding them resends.
    const wanted = new Set(keys.flatMap((k) => metrics.map((m) => `${k}\0${m}`)));
    for (const id of [...this.sent.keys()]) if (!wanted.has(id)) this.sent.delete(id);
    const patch: RunSummary[] = [];
    for (const key of keys) {
      const r = await this.store.pollHistory(key);
      if (r.summary) patch.push(r.summary);
    }
    if (patch.length) this.post({ type: 'runsPatch', upserts: patch, removed: [], refreshedAt: Date.now() });
    this.sendSeries(keys);
  }

  /**
   * Writes the rows the table shows as CSV into TraceML's cache folder. Rows are rebuilt from the
   * host's run data; only keys, column ids and view settings come from the webview. Run data is
   * never modified.
   */
  private async exportTable(request: ExportRequest): Promise<void> {
    const runs = new Map(this.store.summaries().map((r) => [r.key, r]));
    const dirs = new Map([...runs.keys()].map((k) => [k, this.store.dirOf(k) ?? k]));
    const now = new Date();
    const table = buildTableExport(request, runs, dirs);
    try {
      const { file, latest } = await this.cache().writeExport(exportFileName(now), serializeTableCsv(table));
      this.lastExport = { file: file.fsPath, latest: latest.fsPath };
      this.output.appendLine(`Exported ${table.rows.length} rows to ${file.fsPath}`);
      this.post({ type: 'exported', path: file.fsPath, latestPath: latest.fsPath, rows: table.rows.length, exportedAt: now.toISOString() });
    } catch (e) {
      this.reportError('Export failed', e);
    }
  }

  /** Saves a plot rendered by the webview (PNG, 300 DPI) into `<cache>/plots/`. */
  private async savePlot(title: string, base64: string): Promise<void> {
    const bytes = new Uint8Array(Buffer.from(base64, 'base64'));
    if (bytes.length > MAX_PNG_BYTES || !isPng(bytes)) {
      this.reportError('Save plot failed', 'the rendered image is not a valid PNG');
      return;
    }
    try {
      const png = setPngDpi(bytes);
      const file = await this.cache().writePlot(plotFileName(title, new Date()), png);
      this.lastPlot = file.fsPath;
      const { width, height } = pngSize(png);
      this.output.appendLine(`Saved plot ${width}x${height} px to ${file.fsPath}`);
      this.post({ type: 'plotSaved', path: file.fsPath, width, height });
    } catch (e) {
      this.reportError('Save plot failed', e);
    }
  }

  /** Opens a run file read-only (only the fixed file names, only inside the run folder). */
  private async openFile(runKey: string, file: string): Promise<void> {
    const real = await this.store.resolveRunFile(runKey, file);
    if (!real) {
      this.post({ type: 'error', message: `${file} is not available in this run (missing, or outside the run folder).` });
      return;
    }
    await vscode.commands.executeCommand('vscode.open', this.readonlyFiles.uriFor(real), { preview: true });
  }

  private reportError(context: string, e: unknown): void {
    const message = `${context}: ${e instanceof Error ? e.message : String(e)}`;
    this.output.appendLine(message);
    this.post({ type: 'error', message });
  }

  private html(webview: vscode.Webview, remembered: unknown): string {
    const n = nonce();
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'dist', 'webview.css'));
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${n}'`,
    ].join('; ');
    // Remembered UI state, embedded as inert JSON data (not executable; '<' escaped).
    const uiState = JSON.stringify(remembered ?? null).replace(/</g, '\\u003c');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<meta name="traceml-logo" content="${webview.asWebviewUri(vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'curly_m.svg'))}">
<title>TraceML</title>
</head>
<body>
<div id="app"></div>
<script type="application/json" id="traceml-state">${uiState}</script>
<script nonce="${n}" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.poller.stop();
    if (this.indexTimer) clearTimeout(this.indexTimer);
    this.panel?.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}

export function activate(ctx: vscode.ExtensionContext): void {
  const controller = new TraceMLController(ctx);
  // Activity-bar entry: an (intentionally empty) view whose welcome content links to the panel.
  // Opening the view also opens the experiments panel, so one click on the icon is enough.
  const home = vscode.window.createTreeView('traceml.home', {
    treeDataProvider: { getTreeItem: (e: vscode.TreeItem) => e, getChildren: () => [] },
  });
  ctx.subscriptions.push(
    home,
    home.onDidChangeVisibility((e) => {
      if (e.visible) controller.show(true);
    }),
  );
  if (home.visible) controller.show(true);
  ctx.subscriptions.push(
    controller,
    vscode.commands.registerCommand('traceml.showExperiments', () => controller.show()),
    vscode.commands.registerCommand('traceml.refresh', () => controller.refresh()),
    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      deserializeWebviewPanel: async (panel) => controller.attach(panel),
    }),
  );
}

export function deactivate(): void {}
