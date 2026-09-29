import * as vscode from 'vscode';
import { listRuns, resolveRunsRoots, type DiscoveredRun, type RunsRoot } from './discovery';
import { READONLY_SCHEME, ReadonlyRunFiles } from './readonlyFs';
import { joinPath } from './paths';
import { Poller } from './poller';
import { parseWebviewMessage, type HostToWebview, type WebviewToHost } from './protocol';
import { RunStore } from './runStore';
import type { RunSummary, SeriesPayload, ViewConfig } from './types';

const VIEW_TYPE = 'traceml.experiments';
const SERIES_PER_MESSAGE = 16;

interface Settings extends ViewConfig {
  roots: string[];
  maxMetricsFileMB: number;
}

function readSettings(): Settings {
  const c = vscode.workspace.getConfiguration('traceml');
  const num = (key: string, def: number, min: number) => {
    const v = c.get<number>(key, def);
    return typeof v === 'number' && Number.isFinite(v) ? Math.max(min, v) : def;
  };
  return {
    roots: c.get<string[]>('roots', ['runs']),
    refreshIntervalSeconds: num('refreshIntervalSeconds', 5, 1),
    staleAfterSeconds: num('staleAfterSeconds', 60, 1),
    maxPointsPerSeries: Math.floor(num('maxPointsPerSeries', 5000, 100)),
    maxMetricsFileMB: num('maxMetricsFileMB', 64, 1),
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

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.store = new RunStore({
      staleAfterSeconds: this.settings.staleAfterSeconds,
      maxPointsPerSeries: this.settings.maxPointsPerSeries,
      finishedCheckEvery: 6,
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
    this.attach(panel);
  }

  /** Attaches a new or restored (after window reload) panel. */
  attach(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    this.webviewReady = false;
    panel.iconPath = vscode.Uri.joinPath(this.ctx.extensionUri, 'media', 'icon.svg');
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.ctx.extensionUri, 'dist'), vscode.Uri.joinPath(this.ctx.extensionUri, 'media')],
    };
    panel.webview.html = this.html(panel.webview);
    this.panelDisposables.push(
      panel.webview.onDidReceiveMessage((m) => void this.onMessage(m)),
      panel.onDidDispose(() => this.onPanelDisposed()),
    );
    this.forceNext = true;
    this.poller.start();
  }

  refresh(): void {
    if (!this.panel) {
      this.show();
      return;
    }
    this.forceNext = true;
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
        if (!seen.has(run.key)) {
          seen.add(run.key);
          discovered.push(run);
        }
      }
    }

    const { upserts, removed } = await this.store.sync(discovered, { force });
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

  private html(webview: vscode.Webview): string {
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
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
<title>TraceML</title>
</head>
<body>
<div id="app"></div>
<script nonce="${n}" src="${script}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.poller.stop();
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
