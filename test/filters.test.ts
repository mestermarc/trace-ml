import { describe, expect, it } from 'vitest';
import { defaultVisibleColumns, differingParams, filterRuns, matchesSearch, parseColumnFilter, pruneSelection, selectFiltered } from '../src/model/filters';
import { buildComparison } from '../src/model/run';
import { makeRun } from './helpers';

describe('parseColumnFilter', () => {
  const t = (expr: string, v: string | number | boolean | null) => parseColumnFilter(expr).test(v);

  it('numeric comparisons', () => {
    expect(t('> 0.8', 0.81)).toBe(true);
    expect(t('> 0.8', 0.8)).toBe(false);
    expect(t('>=0.8', 0.8)).toBe(true);
    expect(t('<= 1e-3', 0.001)).toBe(true);
    expect(t('<= 1e-3', 0.0011)).toBe(false);
    expect(t('< -1', -2)).toBe(true);
    expect(t('!= 0', 0)).toBe(false);
    expect(t('= 64', 64)).toBe(true);
    expect(t('== 64', 32)).toBe(false);
  });

  it('ranges are inclusive and order-independent', () => {
    expect(t('0.1..0.5', 0.1)).toBe(true);
    expect(t('0.1..0.5', 0.5)).toBe(true);
    expect(t('0.1..0.5', 0.51)).toBe(false);
    expect(t('0.5..0.1', 0.3)).toBe(true);
    expect(t('1e-4..3e-4', 0.0003)).toBe(true);
  });

  it('numeric expressions never match strings or nulls', () => {
    expect(t('> 0', 'abc')).toBe(false);
    expect(t('> 0', null)).toBe(false);
  });

  it('substring matching is case-insensitive', () => {
    expect(t('adam', 'AdamW')).toBe(true);
    expect(t('sgd', 'adamw')).toBe(false);
    expect(t('x', null)).toBe(false);
  });

  it('bare numbers are equality for numeric cells and substring for strings', () => {
    expect(t('64', 64)).toBe(true);
    expect(t('64', 640)).toBe(false);
    expect(t('64', 'b64')).toBe(true);
  });

  it('regex matching', () => {
    expect(t('/^res.*18$/', 'resnet18')).toBe(true);
    expect(t('/^vit/', 'resnet18')).toBe(false);
    expect(t('/RESNET/', 'resnet18')).toBe(true);
  });

  it('reports invalid regex instead of throwing', () => {
    const f = parseColumnFilter('/[unclosed/');
    expect(f.error).toMatch(/invalid regex/);
    expect(f.test('anything')).toBe(true);
  });

  it('empty expression matches everything including null', () => {
    expect(t('  ', null)).toBe(true);
  });
});

describe('filterRuns', () => {
  const runs = [
    makeRun({ key: 'a', name: 'baseline', group: 'lr-sweep', tags: ['cv'], displayStatus: 'completed', params: { 'optim.lr': 3e-4, 'optim.name': 'adamw' }, best: { 'val/auc': { value: 0.9, step: 1, epoch: 1, mode: 'max' } } }),
    makeRun({ key: 'b', name: 'high-lr', group: 'lr-sweep', tags: ['sweep'], displayStatus: 'failed', params: { 'optim.lr': 3e-3, 'optim.name': 'sgd' } }),
    makeRun({ key: 'c', name: 'live', group: 'live', displayStatus: 'running', status: 'running', params: { 'optim.lr': 1e-3, 'optim.name': 'adamw' }, best: { 'val/auc': { value: 0.7, step: 1, epoch: 1, mode: 'max' } } }),
    makeRun({ key: 'd', name: 'old', displayStatus: 'stale', status: 'running' }),
  ];
  const none = { search: '', statuses: [], columns: {} };
  const keys = (rs: { key: string }[]) => rs.map((r) => r.key);

  it('free-text search over id/name/group/tags', () => {
    expect(keys(filterRuns(runs, { ...none, search: 'lr-sweep' }))).toEqual(['a', 'b']);
    expect(keys(filterRuns(runs, { ...none, search: 'SWEEP high' }))).toEqual(['b']);
    expect(keys(filterRuns(runs, { ...none, search: 'cv' }))).toEqual(['a']);
    expect(matchesSearch(runs[0]!, '')).toBe(true);
  });

  it('status multi-select (stale is its own status)', () => {
    expect(keys(filterRuns(runs, { ...none, statuses: ['running', 'failed'] }))).toEqual(['b', 'c']);
    expect(keys(filterRuns(runs, { ...none, statuses: ['stale'] }))).toEqual(['d']);
  });

  it('per-column expressions combine with AND', () => {
    expect(keys(filterRuns(runs, { ...none, columns: { 'param:optim.lr': '<= 1e-3' } }))).toEqual(['a', 'c']);
    expect(keys(filterRuns(runs, { ...none, columns: { 'param:optim.lr': '<= 1e-3', 'best:val/auc': '> 0.8' } }))).toEqual(['a']);
    expect(keys(filterRuns(runs, { ...none, columns: { 'param:optim.name': '/^adam/' } }))).toEqual(['a', 'c']);
  });

  it('ignores invalid column expressions', () => {
    expect(filterRuns(runs, { ...none, columns: { name: '/(/' } })).toHaveLength(4);
  });
});

describe('differingParams and default columns', () => {
  const runs = [
    makeRun({ key: 'a', params: { lr: 1, bs: 64, same: 'x', opt: 'adam', only_a: 1 }, best: { 'val/auc': { value: 1, step: 1, epoch: 1, mode: 'max' } }, summary: { 'test/auc': 0.8 } }),
    makeRun({ key: 'b', params: { lr: 2, bs: 64, same: 'x', opt: 'sgd' }, summary: { 'test/auc': 0.7 } }),
  ];

  it('finds params that differ, counting missing as different', () => {
    expect(differingParams(runs)).toEqual(['lr', 'only_a', 'opt']);
    expect(differingParams([runs[0]!])).toEqual([]);
  });

  it('default visible columns: fixed + differing params (max 6) + best + summary', () => {
    expect(defaultVisibleColumns(runs)).toEqual([
      'status', 'name', 'group', 'started', 'duration', 'step',
      'param:lr', 'param:only_a', 'param:opt',
      'best:val/auc',
      'summary:test/auc',
    ]);
  });

  it('caps differing params at six', () => {
    const many = [0, 1].map((i) => makeRun({ key: String(i), params: Object.fromEntries(Array.from({ length: 10 }, (_, j) => [`p${j}`, i])) }));
    expect(defaultVisibleColumns(many).filter((c) => c.startsWith('param:'))).toHaveLength(6);
  });
});

describe('selection', () => {
  const runs = [makeRun({ key: 'a' }), makeRun({ key: 'b' }), makeRun({ key: 'c' })];

  it('select filtered adds to the current selection', () => {
    expect([...selectFiltered(new Set(['x']), runs.slice(0, 2))].sort()).toEqual(['a', 'b', 'x']);
  });

  it('prunes deleted runs from the selection', () => {
    expect([...pruneSelection(new Set(['a', 'gone']), new Set(['a', 'b']))]).toEqual(['a']);
  });
});

describe('buildComparison', () => {
  it('lists all params with differing ones flagged, and last/best/summary side by side', () => {
    const a = makeRun({ key: 'a', params: { lr: 1, bs: 64 }, last: { loss: 0.5 }, best: { auc: { value: 0.9, step: 3, epoch: 3, mode: 'max' } }, summary: { 'test/auc': 0.88 } });
    const b = makeRun({ key: 'b', params: { lr: 2, bs: 64, extra: true }, last: { loss: 0.5 }, summary: {} });
    const c = buildComparison([a, b]);
    expect(c.params).toEqual([
      { label: 'bs', values: [64, 64], differs: false },
      { label: 'extra', values: [null, true], differs: true },
      { label: 'lr', values: [1, 2], differs: true },
    ]);
    expect(c.metrics).toEqual([
      { label: 'last loss', values: [0.5, 0.5], differs: false },
      { label: 'best auc', values: [0.9, null], differs: true },
      { label: 'summary test/auc', values: [0.88, null], differs: true },
    ]);
  });
});
