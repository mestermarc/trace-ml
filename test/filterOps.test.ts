// Filter builder: operators (=, !=, >, ..., contains, not contains), readable labels, value suggestions.
import { describe, expect, it } from 'vitest';
import { buildFilterExpr, describeFilter, filterRuns, parseColumnFilter, suggestValues } from '../src/model/filters';
import { makeRun } from './helpers';

const t = (expr: string, v: string | number | boolean | null) => parseColumnFilter(expr).test(v);

describe('filter operators', () => {
  it('contains / not contains (case-insensitive; missing values never match)', () => {
    expect(t('~ adam', 'AdamW')).toBe(true);
    expect(t('~adam', 'sgd')).toBe(false);
    expect(t('!~ adam', 'sgd')).toBe(true);
    expect(t('!~ adam', 'adamw')).toBe(false);
    expect(t('!~ adam', null)).toBe(false);
    expect(t('~ 0.00', 0.003)).toBe(true); // numbers are matched as text
    expect(parseColumnFilter('~').error).not.toBeNull();
  });

  it('= and != on text are exact matches, on numbers numeric', () => {
    expect(t('= adamw', 'AdamW')).toBe(true);
    expect(t('= adam', 'adamw')).toBe(false);
    expect(t('!= adam', 'adamw')).toBe(true);
    expect(t('!= adamw', 'adamw')).toBe(false);
    expect(t('= 64', 64)).toBe(true);
    expect(t('!= 64', 32)).toBe(true);
    expect(t('= cifar10', 'cifar100')).toBe(false);
  });

  it('keeps the old expressions working unchanged (saved filters from earlier versions)', () => {
    expect(t('adam', 'AdamW')).toBe(true); // bare text = contains
    expect(t('> 0.8', 0.9)).toBe(true);
    expect(t('0.1..0.5', 0.3)).toBe(true);
    expect(t('64', 64)).toBe(true);
    expect(t('/^ad/', 'adam')).toBe(true);
  });

  it('builds expressions from operator + value, and describes them back', () => {
    expect(buildFilterExpr('contains', ' adam ')).toBe('~ adam');
    expect(buildFilterExpr('not contains', 'adam')).toBe('!~ adam');
    expect(buildFilterExpr('>=', '0.8')).toBe('>= 0.8');
    expect(buildFilterExpr('=', 'adamw')).toBe('= adamw');
    expect(buildFilterExpr('between', '0.1 0.5')).toBe('0.1..0.5');
    expect(buildFilterExpr('between', '0.1..0.5')).toBe('0.1..0.5');
    expect(buildFilterExpr('regex', '^ad')).toBe('/^ad/');
    expect(describeFilter('~ adam')).toBe('contains adam');
    expect(describeFilter('!~ adam')).toBe('not contains adam');
    expect(describeFilter('0.1..0.5')).toBe('between 0.1 and 0.5');
    expect(describeFilter('adam')).toBe('contains adam');
    expect(describeFilter('64')).toBe('= 64');
    expect(describeFilter('>= 0.8')).toBe('>= 0.8');
    for (const op of ['=', '!=', '>', '>=', '<', '<=', 'contains', 'not contains'] as const) expect(parseColumnFilter(buildFilterExpr(op, '5')).error).toBeNull();
  });

  it('filters runs with the new operators', () => {
    const runs = [makeRun({ key: 'a', params: { opt: 'adamw' } }), makeRun({ key: 'b', params: { opt: 'sgd' } }), makeRun({ key: 'c' })];
    const keys = (expr: string) => filterRuns(runs, { search: '', statuses: [], columns: { 'param:opt': expr } }).map((r) => r.key);
    expect(keys('!~ adam')).toEqual(['b']);
    expect(keys('= sgd')).toEqual(['b']);
    expect(keys('!= sgd')).toEqual(['a']);
  });
});

describe('value suggestions', () => {
  const runs = [
    makeRun({ key: 'a', params: { opt: 'adamw', lr: 0.001 }, tags: ['cv', 'fast'] }),
    makeRun({ key: 'b', params: { opt: 'sgd', lr: 0.01 }, tags: ['cv'] }),
    makeRun({ key: 'c', params: { opt: 'adamw', lr: 0.001 } }),
    makeRun({ key: 'd', params: { opt: null } }),
  ];
  it('lists distinct values, most frequent first, skipping missing ones', () => {
    expect(suggestValues(runs, 'param:opt')).toEqual(['adamw', 'sgd']);
    expect(suggestValues(runs, 'param:lr')).toEqual(['0.001', '0.01']);
    expect(suggestValues(runs, 'tags')).toEqual(['cv', 'fast']);
    expect(suggestValues(runs, 'param:missing')).toEqual([]);
    expect(suggestValues(runs, 'param:opt', 1)).toEqual(['adamw']);
  });
});
