// Date / datetime filtering: date columns are detected and compared chronologically.
import { describe, expect, it } from 'vitest';
import { buildFilterExpr, dateValue, describeFilter, filterRuns, isDateColumn, parseColumnFilter, parseDateLiteral, suggestValues } from '../src/model/filters';
import { makeRun } from './helpers';

const local = (...a: [number, number, number?, number?, number?]) => new Date(a[0], a[1] - 1, a[2] ?? 1, a[3] ?? 0, a[4] ?? 0).getTime();
const d = (expr: string, v: string | number | null) => parseColumnFilter(expr, { date: true }).test(v);

describe('date literals', () => {
  it('a date stands for its day, a time for its minute, a month for the month (local time)', () => {
    expect(parseDateLiteral('2026-09-28')).toEqual({ start: local(2026, 9, 28), end: local(2026, 9, 29) });
    expect(parseDateLiteral('2026-09-28 14:30')).toEqual({ start: local(2026, 9, 28, 14, 30), end: local(2026, 9, 28, 14, 31) });
    expect(parseDateLiteral('2026-09-28T14:30')).toEqual(parseDateLiteral('2026-09-28 14:30'));
    expect(parseDateLiteral('2026-09')).toEqual({ start: local(2026, 9, 1), end: local(2026, 10, 1) });
    expect(parseDateLiteral('2026-12-31')!.end).toBe(local(2027, 1, 1));
  });

  it('offsets and Z are absolute', () => {
    expect(parseDateLiteral('2026-09-28T10:00:00Z')!.start).toBe(Date.UTC(2026, 8, 28, 10));
    expect(parseDateLiteral('2026-09-28T12:00:00+02:00')!.start).toBe(Date.UTC(2026, 8, 28, 10));
    expect(parseDateLiteral('2026-09-28T05:30-0430')!.start).toBe(Date.UTC(2026, 8, 28, 10));
    expect(parseDateLiteral('2026-09-28T10:00:00.250Z')).toEqual({ start: Date.UTC(2026, 8, 28, 10, 0, 0, 250), end: Date.UTC(2026, 8, 28, 10, 0, 0, 251) });
  });

  it('rejects impossible dates and non-dates', () => {
    for (const s of ['2026-02-30', '2026-13-01', '2026-09-28 25:00', '2026-09-28 10:61', 'yesterday', '2026', '0.5', '2026-09-28Z']) expect(parseDateLiteral(s), s).toBeNull();
  });

  it('cell values: timestamps as they are, date strings parsed, anything else null', () => {
    expect(dateValue(1000)).toBe(1000);
    expect(dateValue('2026-09-28T10:00:00Z')).toBe(Date.UTC(2026, 8, 28, 10));
    expect(dateValue('adamw')).toBeNull();
    expect(dateValue(null)).toBeNull();
  });
});

describe('date conditions', () => {
  const day = local(2026, 9, 28, 12);
  it('before / after / on / not on compare whole days', () => {
    expect(d('< 2026-09-28', day)).toBe(false);
    expect(d('< 2026-09-29', day)).toBe(true);
    expect(d('<= 2026-09-28', day)).toBe(true);
    expect(d('> 2026-09-28', day)).toBe(false);
    expect(d('> 2026-09-27', day)).toBe(true);
    expect(d('>= 2026-09-28', day)).toBe(true);
    expect(d('= 2026-09-28', day)).toBe(true);
    expect(d('2026-09-28', day)).toBe(true);
    expect(d('!= 2026-09-28', day)).toBe(false);
    expect(d('!= 2026-09-27', day)).toBe(true);
  });

  it('times narrow the comparison', () => {
    expect(d('> 2026-09-28 11:59', day)).toBe(true);
    expect(d('> 2026-09-28 12:00', day)).toBe(false);
    expect(d('>= 2026-09-28 12:00', day)).toBe(true);
  });

  it('ranges include both ends (whole days), in either order', () => {
    expect(d('2026-09-01..2026-09-28', day)).toBe(true);
    expect(d('2026-09-28..2026-09-01', day)).toBe(true);
    expect(d('2026-09-01..2026-09-27', day)).toBe(false);
    expect(d('2026-09..2026-09', day)).toBe(true);
  });

  it('compares date strings chronologically, across time zones, not as text', () => {
    // 23:30 at -05:00 is already the next day in UTC
    expect(d('> 2026-09-28T23:00Z', '2026-09-28T23:30:00-05:00')).toBe(true);
    expect(d('< 2026-09-29T04:00Z', '2026-09-28T23:30:00-05:00')).toBe(false);
    expect(d('< 2026-09-29T05:00Z', '2026-09-28T23:30:00-05:00')).toBe(true);
    expect(d('< 2026-10-01', '2026-9-30')).toBe(true); // "2026-9-30" > "2026-10-01" as text
  });

  it('missing and non-date cells never match', () => {
    expect(d('< 2030-01-01', null)).toBe(false);
    expect(d('!= 2030-01-01', null)).toBe(false);
    expect(d('< 2030-01-01', 'n/a')).toBe(false);
  });

  it('flags invalid dates; other expressions keep their meaning', () => {
    expect(parseColumnFilter('> 2026-02-30', { date: true }).error).toMatch(/not a valid date/);
    expect(parseColumnFilter('2026-01-01..2026-13-01', { date: true }).error).toMatch(/2026-13-01/);
    expect(d('> 1000', 2000)).toBe(true); // raw timestamps still work
    expect(d('~ 2026-09', '2026-09-28')).toBe(true);
  });

  it('without the date option, behaviour is unchanged', () => {
    expect(parseColumnFilter('> 2026-09-01').test(local(2026, 9, 28))).toBe(false); // substring, as before
    expect(parseColumnFilter('2026-09').test('2026-09-28')).toBe(true);
    expect(parseColumnFilter('> 0.5').test(0.7)).toBe(true);
  });
});

describe('date columns', () => {
  const runs = [
    makeRun({ key: 'a', name: 'a', startedAt: local(2026, 9, 1, 9), params: { date: '2026-09-01', opt: 'adam', when: '2026-09-01T10:00:00Z' } }),
    makeRun({ key: 'b', name: 'b', startedAt: local(2026, 9, 15, 9), params: { date: '2026-09-15', opt: 'sgd', when: null } }),
    makeRun({ key: 'c', name: 'c', startedAt: local(2026, 9, 30, 23, 59), params: { date: '2026-09-30', opt: '2026-01-01', when: '2026-09-30T10:00:00Z' } }),
  ];
  const keys = (col: string, expr: string) => filterRuns(runs, { search: '', statuses: [], columns: { [col]: expr } }).map((r) => r.key);

  it('detects timestamp columns and all-date config fields', () => {
    expect(isDateColumn(runs, 'started')).toBe(true);
    expect(isDateColumn(runs, 'param:date')).toBe(true);
    expect(isDateColumn(runs, 'param:when')).toBe(true); // missing values are skipped
    expect(isDateColumn(runs, 'param:opt')).toBe(false); // only some values are dates
    expect(isDateColumn(runs, 'name')).toBe(false);
  });

  it('filters runs by date', () => {
    expect(keys('started', '< 2026-09-15')).toEqual(['a']);
    expect(keys('started', '>= 2026-09-15')).toEqual(['b', 'c']);
    expect(keys('started', '2026-09-30')).toEqual(['c']);
    expect(keys('param:date', '2026-09-02..2026-09-30')).toEqual(['b', 'c']);
    expect(keys('param:when', '> 2026-09-01T12:00Z')).toEqual(['c']);
    expect(keys('param:opt', '~ 2026')).toEqual(['c']); // not a date column: text as before
  });

  it('builder operators and readable labels', () => {
    expect(buildFilterExpr('before', '2026-09-01')).toBe('< 2026-09-01');
    expect(buildFilterExpr('on or after', '2026-09-01 08:00')).toBe('>= 2026-09-01 08:00');
    expect(buildFilterExpr('not on', '2026-09-01')).toBe('!= 2026-09-01');
    expect(describeFilter('< 2026-09-01', { date: true })).toBe('before 2026-09-01');
    expect(describeFilter('>= 2026-09-01 08:00', { date: true })).toBe('on or after 2026-09-01 08:00');
    expect(describeFilter('2026-09-01..2026-09-30', { date: true })).toBe('between 2026-09-01 and 2026-09-30');
    expect(describeFilter('2026-09-01', { date: true })).toBe('on 2026-09-01');
    expect(describeFilter('< 2026-09-01')).toBe('contains < 2026-09-01');
  });

  it('suggests timestamps as days', () => {
    expect(suggestValues(runs, 'started').sort()).toEqual(['2026-09-01', '2026-09-15', '2026-09-30']);
  });
});
