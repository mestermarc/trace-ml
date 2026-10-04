// Where TraceML keeps its own small files (remembered view, table exports). Pure: no vscode.
import { isAbsolutePath, joinPath, normalizePath } from './paths';

export const DEFAULT_CACHE_DIR = './traceml/.cache';

/**
 * Resolves the `traceml.cacheDir` setting: an absolute path is used as is; a relative path is
 * resolved against the first workspace folder. Returns null when it cannot be resolved (relative
 * path and no folder open); the caller then falls back to VS Code's extension storage.
 */
export function resolveCacheDirPath(setting: string | undefined, workspaceFolders: readonly string[]): string | null {
  const raw = (setting ?? '').trim() || DEFAULT_CACHE_DIR;
  if (isAbsolutePath(raw)) return normalizePath(raw);
  const first = workspaceFolders[0];
  if (!first) return null;
  const rel = raw.replace(/^\.[\\/]+/, '');
  return rel === '' || rel === '.' ? normalizePath(first) : joinPath(first, rel);
}
