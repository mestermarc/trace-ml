import { describe, expect, it } from 'vitest';
import { DEFAULT_CACHE_DIR, resolveCacheDirPath } from '../src/cacheDir';

describe('cache folder resolution', () => {
  it('defaults to traceml/.cache in the first workspace folder', () => {
    expect(DEFAULT_CACHE_DIR).toBe('./traceml/.cache');
    expect(resolveCacheDirPath(undefined, ['/mnt/home/me/proj'])).toBe('/mnt/home/me/proj/traceml/.cache');
    expect(resolveCacheDirPath('', ['/mnt/home/me/proj', '/other'])).toBe('/mnt/home/me/proj/traceml/.cache');
  });

  it('resolves relative paths (with or without ./) against the workspace, Windows too', () => {
    expect(resolveCacheDirPath('cache/traceml', ['/p'])).toBe('/p/cache/traceml');
    expect(resolveCacheDirPath('./x', ['E:\\Projects\\P'])).toBe('e:/Projects/P/x');
  });

  it('uses absolute paths as is', () => {
    expect(resolveCacheDirPath('/scratch/me/traceml-cache', ['/p'])).toBe('/scratch/me/traceml-cache');
    expect(resolveCacheDirPath('D:\\cache', [])).toBe('d:/cache');
  });

  it('returns null for a relative path without an open folder (caller falls back to VS Code storage)', () => {
    expect(resolveCacheDirPath('./traceml/.cache', [])).toBeNull();
  });
});
