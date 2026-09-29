// Read confinement. Every file TraceML reads goes through `resolveInside`, which resolves symlinks
// and refuses anything whose real location is outside the allowed folder (a run directory or a
// configured runs root). TraceML never writes: this module only exposes read-side helpers.
import { promises as fs } from 'node:fs';
import { normalizePath, relativePath } from './paths';

export type Resolved = { ok: true; real: string } | { ok: false; reason: 'missing' | 'outside' };

/** Real (symlink-free) absolute path, or null if it does not exist. */
export async function realpathSafe(p: string): Promise<string | null> {
  try {
    return normalizePath(await fs.realpath(p));
  } catch {
    return null;
  }
}

export function isInside(parentReal: string, childReal: string): boolean {
  return relativePath(parentReal, childReal) !== null;
}

/**
 * Resolves `path` (following symlinks) and checks that it stays inside `allowedReal`.
 * Returns the real path to use for the actual read.
 */
export async function resolveInside(path: string, allowedReal: string): Promise<Resolved> {
  const real = await realpathSafe(path);
  if (real === null) return { ok: false, reason: 'missing' };
  return isInside(allowedReal, real) ? { ok: true, real } : { ok: false, reason: 'outside' };
}
