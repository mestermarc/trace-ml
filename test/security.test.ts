// Static guarantees about the extension source: TraceML only ever reads.
// These tests fail if someone adds a filesystem write, a process spawn or a network call.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');

function sources(dir = SRC): { file: string; text: string }[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return sources(p);
    return /\.ts$/.test(name) ? [{ file: p.slice(SRC.length + 1), text: readFileSync(p, 'utf-8') }] : [];
  });
}

const ALL = sources();
const ALLOWED_FS_CALLS = new Set(['stat', 'lstat', 'readFile', 'readdir', 'realpath', 'open']);

describe('TraceML source is read-only', () => {
  it('only imports the read side of node:fs', () => {
    for (const { file, text } of ALL) {
      for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'(?:node:)?fs(?:\/promises)?'/g)) {
        const names = m[1]!.split(',').map((x) => x.trim()).filter(Boolean);
        for (const n of names) expect([`${file}: ${n}`]).toEqual([expect.stringMatching(/: (promises as fs|type Dirent)$/)]);
      }
    }
  });

  it('calls only read-only fs functions', () => {
    for (const { file, text } of ALL) {
      if (file === 'cacheStore.ts') continue; // checked separately below (TraceML cache folder only)
      for (const m of text.matchAll(/\bfs\.(\w+)\s*\(/g)) {
        expect(ALLOWED_FS_CALLS.has(m[1]!), `${file} calls fs.${m[1]}`).toBe(true);
      }
    }
  });

  it('opens files only in read mode', () => {
    for (const { file, text } of ALL) {
      for (const m of text.matchAll(/\bfs\.open\(([^)]*)\)/g)) {
        expect(m[1], `${file}: fs.open(${m[1]})`).toMatch(/,\s*'r'\s*$/);
      }
    }
  });

  it('uses no VS Code write / edit APIs outside the cache module', () => {
    const forbidden = /workspace\.fs\.(writeFile|delete|rename|copy|createDirectory)|WorkspaceEdit|applyEdit|\.save\(|saveAll/;
    for (const { file, text } of ALL) {
      if (file === 'cacheStore.ts') continue;
      expect(forbidden.test(text), file).toBe(false);
    }
  });

  it('the cache module only writes fixed file names inside the cache folder', () => {
    const c = ALL.find((x) => x.file === 'cacheStore.ts')!.text;
    expect(c).toMatch(/this\.exportsDir = vscode\.Uri\.joinPath\(dir, 'exports'\)/);
    expect(c).toMatch(/this\.plotsDir = vscode\.Uri\.joinPath\(dir, 'plots'\)/);
    // every write / delete / mkdir targets the cache folder or a fixed name joined onto it
    const allowedTargets = ['this.dir', 'this.exportsDir', 'this.plotsDir', 'file', 'latest', 'ui', 'idx', 'hidden', 'vscode.Uri.joinPath(dir'];
    const calls = [...c.matchAll(/workspace\.fs\.(writeFile|delete|createDirectory)\(([^,)]*)/g)];
    expect(calls.length).toBeGreaterThan(0);
    for (const m of calls) expect(allowedTargets, `${m[1]}(${m[2]})`).toContain(m[2]!.trim());
    expect(c).toMatch(/const ui = vscode\.Uri\.joinPath\(this\.dir, UI_STATE_FILE\)/);
    expect(c).toMatch(/const idx = vscode\.Uri\.joinPath\(this\.dir, RUNS_INDEX_FILE\)/);
    expect(c).toMatch(/const hidden = vscode\.Uri\.joinPath\(this\.dir, HIDDEN_RUNS_FILE\)/);
    expect(c).toMatch(/if \(!EXPORT_NAME\.test\(name\)\) throw/);
    expect(c).toMatch(/if \(!PLOT_NAME\.test\(name\)\) throw/);
    // prune() only deletes files of the folder it lists that match the strict name pattern
    expect(c).toMatch(/\.filter\(\(\[n, t\]\) => t === vscode\.FileType\.File && pattern\.test\(n\)\)/);
    expect(c.match(/this\.prune\(/g)).toHaveLength(2);
    expect(c).toMatch(/this\.prune\(this\.exportsDir, EXPORT_NAME, KEEP_EXPORTS\)/);
    expect(c).toMatch(/this\.prune\(this\.plotsDir, PLOT_NAME, KEEP_PLOTS\)/);
    expect(c).not.toMatch(/\.rename\(|\.copy\(/);
    // the store is only created from the resolved cache setting (or VS Code's extension storage)
    const ext = ALL.find((x) => x.file === 'extension.ts')!.text;
    expect(ext.match(/new CacheStore\(/g)).toHaveLength(1);
    expect(ext).toMatch(/new CacheStore\(path \? vscode\.Uri\.file\(path\) : vscode\.Uri\.joinPath\(this\.ctx\.globalStorageUri, 'cache'\)\)/);
    expect(ext).toMatch(/const path = resolveCacheDirPath\(this\.settings\.cacheDir, folders\)/);
  });

  it('starts no processes and makes no network calls', () => {
    const forbidden = /from\s+'(?:node:)?(child_process|http|https|http2|net|tls|dgram|dns|worker_threads|cluster)'|\bfetch\(|XMLHttpRequest|WebSocket|\beval\(|new Function\(/;
    for (const { file, text } of ALL) expect(forbidden.test(text), file).toBe(false);
  });

  it('webview CSP allows no remote content', () => {
    const ext = ALL.find((s) => s.file === 'extension.ts')!.text;
    expect(ext).toContain("default-src 'none'");
    expect(ext).toMatch(/script-src 'nonce-/);
    expect(ext).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  });

  it('the read-only file viewer refuses every write operation', () => {
    const ro = ALL.find((s) => s.file === 'readonlyFs.ts')!.text;
    for (const op of ['writeFile', 'delete', 'rename', 'createDirectory']) {
      expect(ro).toMatch(new RegExp(`${op}\\(uri: vscode\\.Uri\\): never \\{\\s*throw vscode\\.FileSystemError\\.NoPermissions`));
    }
    expect(ALL.find((s) => s.file === 'extension.ts')!.text).toMatch(/registerFileSystemProvider\(READONLY_SCHEME, this\.readonlyFiles, \{ isReadonly: true/);
  });
});
