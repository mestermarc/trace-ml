// The TraceML view in the activity bar: runs grouped by status (running / stale / failed first),
// each with its key metric and age. Clicking a run opens it in the panel's inspector. Data comes
// from the controller's run store; the view itself reads no files.
import * as vscode from 'vscode';
import { explorerGroups, runDescription, runTooltip, type ExplorerGroup } from './model/explorer';
import type { DisplayStatus, RunSummary } from './types';

type Node = { kind: 'group'; group: ExplorerGroup } | { kind: 'run'; run: RunSummary };

const STATUS_ICON: Record<DisplayStatus, [string, string]> = {
  running: ['pulse', 'charts.green'],
  stale: ['warning', 'charts.yellow'],
  failed: ['error', 'charts.red'],
  completed: ['pass', 'charts.green'],
  killed: ['circle-slash', 'charts.orange'],
  unknown: ['question', 'descriptionForeground'],
};

export interface ExplorerSource {
  runs(): RunSummary[];
  onRunsChanged: vscode.Event<void>;
}

export class RunsTreeProvider implements vscode.TreeDataProvider<Node> {
  private readonly emitter = new vscode.EventEmitter<Node | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private groups: ExplorerGroup[] = [];

  constructor(private readonly source: ExplorerSource) {}

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getChildren(node?: Node): Node[] {
    if (!node) {
      this.groups = explorerGroups(this.source.runs());
      return this.groups.map((group) => ({ kind: 'group', group }));
    }
    return node.kind === 'group' ? node.group.runs.map((run) => ({ kind: 'run', run })) : [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'group') {
      const g = node.group;
      const item = new vscode.TreeItem(g.label, g.expanded ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `group:${g.status}`;
      item.description = String(g.runs.length);
      const [icon, color] = STATUS_ICON[g.status];
      item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
      item.contextValue = 'traceml.group';
      return item;
    }
    const r = node.run;
    const item = new vscode.TreeItem(r.name, vscode.TreeItemCollapsibleState.None);
    item.id = `run:${r.key}`;
    item.description = runDescription(r, Date.now());
    item.tooltip = runTooltip(r);
    const [icon, color] = r.warnings.length ? ['warning', 'charts.yellow'] : STATUS_ICON[r.displayStatus];
    item.iconPath = new vscode.ThemeIcon(icon, new vscode.ThemeColor(color));
    item.contextValue = 'traceml.run';
    item.command = { command: 'traceml.revealRun', title: 'Show run details', arguments: [r.key] };
    return item;
  }
}

/** Run key from a command argument: a tree node (context menu) or the key itself (click). */
export function runKeyOf(arg: unknown): string | null {
  if (typeof arg === 'string') return arg;
  if (arg && typeof arg === 'object' && (arg as Node).kind === 'run') return (arg as { run: RunSummary }).run.key;
  return null;
}
