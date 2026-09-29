import { describe, expect, it } from 'vitest';
import { GlobSet, basename, globToRegExp, isAbsolutePath, joinPath, normalizePath, relativePath } from '../src/paths';

describe('paths (Windows and POSIX)', () => {
  it('normalizes Windows separators and drive letters', () => {
    expect(normalizePath('E:\\Projects\\TraceML\\runs\\')).toBe('e:/Projects/TraceML/runs');
    expect(normalizePath('C:\\')).toBe('c:/');
    expect(normalizePath('/home/u//proj/runs/')).toBe('/home/u/proj/runs');
    expect(normalizePath('\\\\server\\share\\runs')).toBe('//server/share/runs');
  });

  it('detects absolute paths on both platforms', () => {
    expect(isAbsolutePath('C:\\data\\runs')).toBe(true);
    expect(isAbsolutePath('d:/data/runs')).toBe(true);
    expect(isAbsolutePath('/data/runs')).toBe(true);
    expect(isAbsolutePath('\\\\server\\share')).toBe(true);
    expect(isAbsolutePath('**/runs')).toBe(false);
    expect(isAbsolutePath('runs')).toBe(false);
  });

  it('computes relative paths, case-insensitively for drive paths', () => {
    expect(relativePath('E:\\Proj', 'e:/proj/exp/runs/a')).toBe('exp/runs/a');
    expect(relativePath('/home/u/proj', '/home/u/proj/runs')).toBe('runs');
    expect(relativePath('/home/u/proj', '/home/u/proj')).toBe('');
    expect(relativePath('/home/u/proj', '/home/u/project/runs')).toBeNull();
    expect(relativePath('/home/u/Proj', '/home/u/proj/runs')).toBeNull();
  });

  it('joins and takes basenames with mixed separators', () => {
    expect(joinPath('E:\\a', 'runs', 'r1')).toBe('e:/a/runs/r1');
    expect(basename('E:\\a\\runs\\r1')).toBe('r1');
    expect(basename('/a/runs/r1/')).toBe('r1');
  });
});

describe('globToRegExp', () => {
  it('matches **/runs at any depth including the top level', () => {
    const re = globToRegExp('**/runs');
    expect(re.test('runs')).toBe(true);
    expect(re.test('exp/a/runs')).toBe(true);
    expect(re.test('exp/myruns')).toBe(false);
    expect(re.test('runs/x')).toBe(false);
  });

  it('supports *, ? and braces', () => {
    expect(globToRegExp('exp*/runs').test('exp12/runs')).toBe(true);
    expect(globToRegExp('exp*/runs').test('exp1/x/runs')).toBe(false);
    expect(globToRegExp('run?').test('run1')).toBe(true);
    expect(globToRegExp('{a,b}/runs').test('b/runs')).toBe(true);
  });

  it('accepts backslash-separated patterns', () => {
    expect(globToRegExp('**\\outputs\\runs').test('x/outputs/runs')).toBe(true);
  });

  it('exclude patterns match the directory itself', () => {
    const ex = new GlobSet(['**/node_modules/**', '**/.git/**']);
    expect(ex.matches('node_modules')).toBe(true);
    expect(ex.matches('a/b/node_modules')).toBe(true);
    expect(ex.matches('a\\.git')).toBe(true);
    expect(ex.matches('a/runs')).toBe(false);
  });
});
