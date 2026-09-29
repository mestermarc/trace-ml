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

  it('uses no VS Code write / edit APIs', () => {
    const forbidden = /workspace\.fs\.(writeFile|delete|rename|copy|createDirectory)|WorkspaceEdit|applyEdit|\.save\(|saveAll/;
    for (const { file, text } of ALL) expect(forbidden.test(text), file).toBe(false);
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
