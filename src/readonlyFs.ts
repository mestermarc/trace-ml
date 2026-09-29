// Read-only view of run files. "Open file" shows files through the `traceml-readonly:` scheme,
// registered with isReadonly, so VS Code cannot edit or save them through TraceML. Only files the
// user explicitly opened from a run (after the confinement check) can be served.
import { promises as fs } from 'node:fs';
import * as vscode from 'vscode';
import { normalizePath } from './paths';

export const READONLY_SCHEME = 'traceml-readonly';

export class ReadonlyRunFiles implements vscode.FileSystemProvider {
  private readonly allowed = new Set<string>();
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  /** Allows one confined real path and returns the read-only URI for it. */
  uriFor(realPath: string): vscode.Uri {
    const p = normalizePath(realPath);
    this.allowed.add(p);
    return vscode.Uri.file(p).with({ scheme: READONLY_SCHEME });
  }

  private pathOf(uri: vscode.Uri): string {
    const p = normalizePath(vscode.Uri.file(uri.path).fsPath);
    if (!this.allowed.has(p)) throw vscode.FileSystemError.NoPermissions(uri);
    return p;
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const st = await fs.stat(this.pathOf(uri)).catch(() => {
      throw vscode.FileSystemError.FileNotFound(uri);
    });
    return { type: vscode.FileType.File, ctime: st.ctimeMs, mtime: st.mtimeMs, size: st.size, permissions: vscode.FilePermission.Readonly };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return fs.readFile(this.pathOf(uri)).catch(() => {
      throw vscode.FileSystemError.FileNotFound(uri);
    });
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  readDirectory(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  // --- everything that would modify the filesystem is refused ---
  createDirectory(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  writeFile(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  delete(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }

  rename(uri: vscode.Uri): never {
    throw vscode.FileSystemError.NoPermissions(uri);
  }
}
