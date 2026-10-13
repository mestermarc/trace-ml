// Run discovery. TraceML only looks inside the runs folders the user configured in `traceml.roots`
// (no recursive search of the workspace). Each direct sub-directory with a marker file is a run.
// Runs whose real location (after symlinks) is outside their runs folder are ignored.
// Candidate folders are never listed: only the fixed marker names are stat'ed, so a folder full of
// checkpoints, datasets or other large files costs a few stat calls. Folders found not to be runs
// are remembered by their modification time and skipped until something is added to them.
import { promises as fs, type Dirent } from 'node:fs';
import { isInside, realpathSafe } from './fsGuard';
import { basename, hasGlobChars, isAbsolutePath, joinPath, normalizePath, relativePath } from './paths';

/** Files that make a directory qualify as a run. */
export const RUN_MARKERS = ['run.json', 'metrics.json', 'metrics.jsonl', 'params.yaml', 'config.json'] as const;

/** Sub-folders of a runs folder that are never runs (tooling caches), skipped without a look. */
export const SKIPPED_DIRS: ReadonlySet<string> = new Set(['node_modules', '__pycache__']);

export interface ListOptions {
  /**
   * Folders already found not to be runs: run key -> the folder's mtime at that check. Updated in
   * place; a folder is checked again only once its mtime changes (a file was added or removed).
   */
  notRuns?: Map<string, number>;
  /** Folders to leave out without checking (e.g. runs deleted from TraceML). */
  skip?: (key: string) => boolean;
}

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
  const missing: string[] = [];
  for (const raw of entries) {
    const entry = raw.trim().replace(/^\.[\\/]+/, '');
    if (!entry || entry === '.') continue;
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
    if (!found) missing.push(entry);
  }
  // Several default locations may be listed; only complain when none of them exists.
  if (roots.size === 0 && missing.length) {
    problems.push(`traceml.roots: no runs folder found (looked for ${missing.map((m) => `"${m}"`).join(', ')}${missing.some((m) => !isAbsolutePath(m)) ? ' in the workspace' : ''})`);
  }
  return { roots: [...roots.values()], problems };
}

/** True if the folder contains a run marker file: stats the fixed names, never lists the folder. */
export async function hasRunMarkerFile(dir: string): Promise<boolean> {
  for (const name of RUN_MARKERS) {
    try {
      if ((await fs.stat(joinPath(dir, name))).isFile()) return true;
    } catch {
      // missing
    }
  }
  return false;
}

/**
 * Lists run directories directly inside a runs root. `known` maps already-discovered run keys to
 * their real path, and `opts.notRuns` remembers folders that are not runs, so steady-state polling
 * costs one readdir per root plus one stat per non-run folder.
 */
export async function listRuns(root: RunsRoot, known: ReadonlyMap<string, string>, opts: ListOptions = {}): Promise<DiscoveredRun[]> {
  const out: DiscoveredRun[] = [];
  const seen = new Set<string>();
  for (const ent of await readDirSafe(root.real)) {
    if (ent.name.startsWith('.')) continue; // temporary
    if (SKIPPED_DIRS.has(ent.name)) continue;
    // Files (checkpoints, archives, datasets...) are never runs and are not looked at.
    if (!ent.isDirectory() && !ent.isSymbolicLink()) continue;
    const dir = joinPath(root.dir, ent.name);
    if (opts.skip?.(dir)) continue;
    let real = known.get(dir);
    if (real === undefined) {
      const r = await realpathSafe(joinPath(root.real, ent.name));
      // Symlinked runs must stay inside the runs folder.
      if (!r || !isInside(root.real, r) || r === root.real) continue;
      let mtime: number;
      try {
        const st = await fs.stat(r);
        if (!st.isDirectory()) continue;
        mtime = st.mtimeMs;
      } catch {
        continue;
      }
      seen.add(dir);
      if (opts.notRuns?.get(dir) === mtime) continue;
      if (!(await hasRunMarkerFile(r))) {
        opts.notRuns?.set(dir, mtime);
        continue;
      }
      opts.notRuns?.delete(dir);
      real = r;
    }
    out.push({ key: dir, dir, real, dirName: ent.name, location: root.label ? `${root.label}/${ent.name}` : ent.name });
  }
  // forget folders that are gone from this root
  if (opts.notRuns) {
    for (const k of opts.notRuns.keys()) {
      const rel = relativePath(root.dir, k);
      if (rel && !rel.includes('/') && !seen.has(k)) opts.notRuns.delete(k);
    }
  }
  return out;
}
