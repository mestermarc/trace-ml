// Pure path/glob helpers. They accept both POSIX and Windows paths regardless of the host
// platform, so behaviour is identical locally, on Windows and on a Remote-SSH Linux host.

/** Converts separators to `/`, collapses duplicates, strips a trailing slash, lowercases a drive letter. */
export function normalizePath(p: string): string {
  let s = p.replace(/\\/g, '/');
  const unc = s.startsWith('//');
  s = s.replace(/\/{2,}/g, '/');
  if (unc) s = '/' + s;
  if (/^[A-Za-z]:/.test(s)) s = s[0]!.toLowerCase() + s.slice(1);
  if (s.length > 1 && s.endsWith('/') && !/^[a-z]:\/$/.test(s)) s = s.slice(0, -1);
  return s;
}

export function isAbsolutePath(p: string): boolean {
  return p.startsWith('/') || p.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(p);
}

export function hasGlobChars(p: string): boolean {
  return /[*?[\]{}]/.test(p);
}

/** Joins path segments with `/` (inputs may use either separator). */
export function joinPath(base: string, ...parts: string[]): string {
  return normalizePath([base, ...parts].join('/'));
}

export function basename(p: string): string {
  const n = normalizePath(p);
  const i = n.lastIndexOf('/');
  return i >= 0 ? n.slice(i + 1) : n;
}

/** Windows paths compare case-insensitively. */
function isWindowsLike(p: string): boolean {
  return /^[a-z]:\//.test(p) || p.startsWith('//');
}

/** Returns `child` relative to `root` with `/` separators, or null if it is not inside `root`. */
export function relativePath(root: string, child: string): string | null {
  const r = normalizePath(root);
  const c = normalizePath(child);
  const ci = isWindowsLike(r);
  const rc = ci ? r.toLowerCase() : r;
  const cc = ci ? c.toLowerCase() : c;
  if (cc === rc) return '';
  const prefix = rc.endsWith('/') ? rc : rc + '/';
  return cc.startsWith(prefix) ? c.slice(prefix.length) : null;
}

/**
 * Converts a glob to a RegExp matched against `/`-separated relative paths.
 * Supports `**` (any number of segments, including zero), `*`, `?`, `{a,b}` and `[...]`.
 */
export function globToRegExp(glob: string, caseInsensitive = false): RegExp {
  const g = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  let re = '';
  let i = 0;
  let braceDepth = 0;
  while (i < g.length) {
    const ch = g[i]!;
    if (ch === '*') {
      if (g[i + 1] === '*') {
        const atSegStart = i === 0 || g[i - 1] === '/';
        const next = g[i + 2];
        if (atSegStart && next === '/') {
          re += '(?:.*/)?';
          i += 3;
          continue;
        }
        if (atSegStart && next === undefined) {
          re += '.*';
          i += 2;
          continue;
        }
        re += '.*';
        i += 2;
        continue;
      }
      re += '[^/]*';
    } else if (ch === '?') {
      re += '[^/]';
    } else if (ch === '{') {
      braceDepth++;
      re += '(?:';
    } else if (ch === '}' && braceDepth > 0) {
      braceDepth--;
      re += ')';
    } else if (ch === ',' && braceDepth > 0) {
      re += '|';
    } else if (ch === '[') {
      const end = g.indexOf(']', i + 1);
      if (end > i) {
        re += '[' + g.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']';
        i = end + 1;
        continue;
      }
      re += '\\[';
    } else if (ch === '/' && g.slice(i, i + 4) === '/**' && i + 3 === g.length) {
      re += '(?:/.*)?';
      i += 3;
      continue;
    } else {
      re += ch.replace(/[.+^$()|\\\]]/g, '\\$&');
    }
    i++;
  }
  return new RegExp('^' + re + '$', caseInsensitive ? 'i' : '');
}

export class GlobSet {
  private readonly res: RegExp[];
  constructor(patterns: readonly string[], caseInsensitive = false) {
    this.res = patterns.filter((p) => p.trim() !== '').map((p) => globToRegExp(p.trim(), caseInsensitive));
  }
  matches(relPath: string): boolean {
    const p = relPath.replace(/\\/g, '/');
    return this.res.some((re) => re.test(p) || re.test(p + '/'));
  }
}
