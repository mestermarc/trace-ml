// Run discovery. TraceML only looks inside the runs folders the user configured in `traceml.roots`
// (no recursive search of the workspace). Each direct sub-directory with a marker file is a run.
// Runs whose real location (after symlinks) is outside their runs folder are ignored.
import { promises as fs, type Dirent } from 'node:fs';
import { isInside, realpathSafe } from './fsGuard';
import { basename, hasGlobChars, isAbsolutePath, joinPath, normalizePath, relativePath } from './paths';

/** Files that make a directory qualify as a run. */
export const RUN_MARKERS = ['run.json', 'metrics.json', 'metrics.jsonl', 'params.yaml', 'config.json'] as const;

export interface FolderLike {
  name: string;
  fsPath: string;
}

export interface RunsRoot {
  /** Normalized path as configured. */
  dir: string;
  /** Real path (symlinks resolved): the confinement boundary for everything under this root. */
  real: string;
  /** Display label (workspace-relative when possible). */
  label: string;
}

export interface DiscoveredRun {
  key: string; // normalized absolute dir
  dir: string;
  /** Real path of the run directory: reads are confined to it. */
  real: string;
  dirName: string;
  location: string;
}

export interface RootsResult {
  roots: RunsRoot[];
  /** Human-readable problems with the configured roots (missing folder, glob pattern...). */
  problems: string[];
}

async function readDirSafe(dir: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function labelFor(dir: string, folders: readonly FolderLike[]): string {
  for (const f of folders) {
    const rel = relativePath(f.fsPath, dir);
    if (rel !== null) return folders.length > 1 ? (rel ? `${f.name}/${rel}` : f.name) : rel || basename(dir);
  }
  return dir;
}

/**
 * Resolves the configured runs folders. Each entry is an absolute path, or a path relative to each
 * workspace folder. Nothing else in the workspace is scanned.
 */
export async function resolveRunsRoots(folders: readonly FolderLike[], entries: readonly string[]): Promise<RootsResult> {
  const roots = new Map<string, RunsRoot>();
  const problems: string[] = [];
  for (const raw of entries) {
    const entry = raw.trim();
    if (!entry) continue;
    if (hasGlobChars(entry)) {
      problems.push(`traceml.roots: "${entry}" is a pattern; only plain folder paths are supported`);
      continue;
    }
    const candidates = isAbsolutePath(entry) ? [normalizePath(entry)] : folders.map((f) => joinPath(f.fsPath, entry));
    let found = false;
    for (const dir of candidates) {
      const real = await realpathSafe(dir);
      if (!real) continue;
      try {
        if (!(await fs.stat(real)).isDirectory()) continue;
      } catch {
        continue;
      }
      found = true;
      if (![...roots.values()].some((r) => r.real === real)) roots.set(dir, { dir, real, label: labelFor(dir, folders) });
    }
    if (!found) problems.push(`traceml.roots: folder "${entry}" not found${isAbsolutePath(entry) ? '' : ' in the workspace'}`);
  }
  return { roots: [...roots.values()], problems };
}

/** True if the directory entries contain a run marker file. */
export function hasRunMarker(names: Iterable<string>): boolean {
  for (const n of names) if ((RUN_MARKERS as readonly string[]).includes(n)) return true;
  return false;
}

/**
 * Lists run directories directly inside a runs root. `known` maps already-discovered run keys to
 * their real path, so steady-state polling costs one readdir per root.
 */
export async function listRuns(root: RunsRoot, known: ReadonlyMap<string, string>): Promise<DiscoveredRun[]> {
  const out: DiscoveredRun[] = [];
  for (const ent of await readDirSafe(root.real)) {
    if (ent.name.startsWith('.')) continue; // temporary
    if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
    const dir = joinPath(root.dir, ent.name);
    let real = known.get(dir);
    if (real === undefined) {
      const r = await realpathSafe(joinPath(root.real, ent.name));
      // Symlinked runs must stay inside the runs folder.
      if (!r || !isInside(root.real, r) || r === root.real) continue;
      try {
        if (!(await fs.stat(r)).isDirectory()) continue;
      } catch {
        continue;
      }
      const names = (await readDirSafe(r)).map((e) => e.name);
      if (!hasRunMarker(names)) continue;
      real = r;
    }
    out.push({ key: dir, dir, real, dirName: ent.name, location: root.label ? `${root.label}/${ent.name}` : ent.name });
  }
  return out;
}
