import { describe, expect, it } from 'vitest';
import { filterRuns, limitRows, moveColumn, parseMaxRows } from '../src/model/filters';
import { sortRuns } from '../src/model/run';
import { buildTableExport, csvCell, csvHeader, exportFileName, plotFileName, serializeTableCsv, type TableExportRequest } from '../src/model/tableExport';
import { parseWebviewMessage } from '../src/protocol';
import { makeRun } from './helpers';

const best = (value: number | null) => ({ value, step: 3, epoch: 3, mode: 'max' });
const runs = Array.from({ length: 250 }, (_, i) =>
  makeRun({
    key: `/data/runs/r${i}`,
    id: `r${i}`,
    name: `run-${i}`,
    group: i % 2 ? 'sweep-a' : 'sweep-b',
    startedAt: Date.UTC(2026, 8, 29, 12, 0, i % 60),
    durationS: 100 + i,
    params: { 'optim.lr': i % 2 ? 1e-3 : 3e-4 },
    best: { 'val/auc': best(0.5 + i / 1000) },
    warnings: i === 3 ? ['metrics.jsonl: 1 malformed line skipped'] : [],
  }),
);

describe('max rows', () => {
  it('is applied after filters and sorting', () => {
    const filtered = filterRuns(runs, { search: 'sweep-a', statuses: [], columns: {} });
    const sorted = sortRuns(filtered, [{ col: 'best:val/auc', dir: 'desc' }]);
    const shown = limitRows(sorted, 100);
    expect(filtered).toHaveLength(125);
    expect(shown).toHaveLength(100);
    expect(shown[0]!.id).toBe('r249'); // highest val/auc among sweep-a first
    expect(shown.every((r) => r.group === 'sweep-a')).toBe(true);
  });

  it('null means all rows; a larger limit than rows changes nothing', () => {
    expect(limitRows(runs, null)).toHaveLength(250);
    expect(limitRows(runs, 1000)).toHaveLength(250);
    expect(limitRows(runs, 25)).toHaveLength(25);
  });

  it('accepts any whole number from 1 to 1000 typed in, or All', () => {
    expect(parseMaxRows('37')).toBe(37);
    expect(parseMaxRows(' 1000 ')).toBe(1000);
    expect(parseMaxRows('All')).toBeNull();
    expect(parseMaxRows('')).toBeNull();
    for (const bad of ['0', '1001', '-5', '2.5', 'abc', '1e3']) expect(parseMaxRows(bad), bad).toBeUndefined();
  });
});

describe('column order', () => {
  const ids = ['status', 'name', 'group', 'param:lr'];
  it('moves a column before or after another one', () => {
    expect(moveColumn(ids, 'param:lr', 'name')).toEqual(['status', 'param:lr', 'name', 'group']);
    expect(moveColumn(ids, 'status', 'group', true)).toEqual(['name', 'group', 'status', 'param:lr']);
    expect(moveColumn(ids, 'name', 'name')).toEqual(ids);
    expect(moveColumn(ids, 'missing', 'name')).toEqual(ids);
  });
});

describe('table export (CSV)', () => {
  const byKey = new Map(runs.map((r) => [r.key, r]));
  const dirs = new Map(runs.map((r) => [r.key, `/mnt/proj/traceml/runs/${r.id}`]));
  const shown = limitRows(sortRuns(runs, [{ col: 'best:val/auc', dir: 'desc' }]), 100);
  const req: TableExportRequest = {
    runKeys: [...shown.map((r) => r.key), '/gone/run'],
    columns: ['status', 'name', 'started', 'duration', 'param:optim.lr', 'best:val/auc', 'nonexistent-fixed'],
    view: { filters: { search: '', statuses: [], columns: {} }, sort: [{ col: 'best:val/auc', dir: 'desc' }], groupBy: null, maxRows: 100 },
    counts: { total: 250, filtered: 250 },
  };
  const table = buildTableExport(req, byKey, dirs);

  it('starts with identity columns, then the visible columns in table order with group prefixes', () => {
    expect(table.header).toEqual(['id', 'name', 'status', 'group', 'tags', 'path', 'started', 'duration_s', 'config.optim.lr', 'run.best.val/auc']);
  });

  it('keeps table order, skips unknown runs and columns, uses the host run directory', () => {
    expect(table.rows).toHaveLength(100);
    expect(table.rows.map((r) => r[0]).slice(0, 3)).toEqual(['r249', 'r248', 'r247']);
    expect(table.rows[0]![5]).toBe('/mnt/proj/traceml/runs/r249');
  });

  it('exports displayed values: ISO timestamps, durations in seconds, config and run metrics', () => {
    expect(table.rows[0]).toEqual(['r249', 'run-249', 'completed', 'sweep-a', '', '/mnt/proj/traceml/runs/r249', new Date(Date.UTC(2026, 8, 29, 12, 0, 249 % 60)).toISOString(), 349, 1e-3, 0.749]);
  });

  it('names every value group: config / run (start, last, best) / summary', () => {
    expect(csvHeader({ kind: 'param', key: 'lr' })).toBe('config.lr');
    expect(csvHeader({ kind: 'first', key: 'val/loss' })).toBe('run.start.val/loss');
    expect(csvHeader({ kind: 'last', key: 'val/loss' })).toBe('run.last.val/loss');
    expect(csvHeader({ kind: 'best', key: 'val/loss' })).toBe('run.best.val/loss');
    expect(csvHeader({ kind: 'summary', key: 'test/auc' })).toBe('summary.test/auc');
  });

  it('serializes to RFC 4180 CSV', () => {
    const text = serializeTableCsv(table);
    const lines = text.trimEnd().split('\n');
    expect(lines).toHaveLength(101);
    expect(lines[0]).toBe('id,name,status,group,tags,path,started,duration_s,config.optim.lr,run.best.val/auc');
    expect(lines[1]).toBe(`r249,run-249,completed,sweep-a,,/mnt/proj/traceml/runs/r249,${new Date(Date.UTC(2026, 8, 29, 12, 0, 9)).toISOString()},349,0.001,0.749`);
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell(' padded')).toBe('" padded"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(true)).toBe('true');
    expect(serializeTableCsv({ header: ['id'], rows: [] })).toBe('id\n');
  });

  it('joins tags with ; and writes null cells empty', () => {
    const r = makeRun({ key: '/x', tags: ['a', 'b'], best: {} });
    const t = buildTableExport({ ...req, runKeys: ['/x'], columns: ['best:val/auc'] }, new Map([['/x', r]]), new Map());
    expect(serializeTableCsv(t).split('\n')[1]).toBe('/x,/x,completed,,a;b,/x,');
  });

  it('uses predictable timestamped file names', () => {
    expect(exportFileName(new Date('2026-10-01T09:05:07Z'))).toBe('table-20261001-090507.csv');
    expect(plotFileName('val/auc', new Date('2026-10-01T09:05:07Z'))).toBe('plot-val-auc-20261001-090507.png');
    expect(plotFileName('../../etc/passwd', new Date('2026-10-01T09:05:07Z'))).toBe('plot-etc-passwd-20261001-090507.png');
    expect(plotFileName('***', new Date('2026-10-01T09:05:07Z'))).toBe('plot-chart-20261001-090507.png');
  });
});

describe('export request validation', () => {
  const ok = {
    runKeys: ['a'],
    columns: ['name'],
    view: { filters: { search: '', statuses: [], columns: {} }, sort: [], groupBy: null, maxRows: 100 },
    counts: { total: 1, filtered: 1 },
  };
  it('accepts a well-formed request', () => {
    expect(parseWebviewMessage({ type: 'exportTable', request: ok })).toEqual({ type: 'exportTable', request: ok });
    expect(parseWebviewMessage({ type: 'copyExportPath' })).toEqual({ type: 'copyExportPath' });
    expect(parseWebviewMessage({ type: 'openExport' })).toEqual({ type: 'openExport' });
  });
  it('rejects malformed requests', () => {
    expect(parseWebviewMessage({ type: 'exportTable' })).toBeNull();
    expect(parseWebviewMessage({ type: 'exportTable', request: { ...ok, runKeys: [1] } })).toBeNull();
    expect(parseWebviewMessage({ type: 'exportTable', request: { ...ok, view: { ...ok.view, maxRows: -5 } } })).toBeNull();
    expect(parseWebviewMessage({ type: 'exportTable', request: { ...ok, view: { ...ok.view, sort: [{ col: 'x', dir: 'sideways' }] } } })).toBeNull();
    expect(parseWebviewMessage({ type: 'exportTable', request: { ...ok, path: '/etc/passwd' } })).toEqual({ type: 'exportTable', request: ok }); // extra keys are dropped
  });
});
