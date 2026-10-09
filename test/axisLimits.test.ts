// Manual scatter axis limits: parsing and validation.
import { describe, expect, it } from 'vitest';
import { axisLimitsError, isAutoLimits, parseAxisLimit, withinLimits } from '../src/model/analysis';

describe('axis limits', () => {
  it('parses empty / auto as automatic, numbers as bounds, anything else as invalid', () => {
    expect(parseAxisLimit('')).toBeNull();
    expect(parseAxisLimit('  auto ')).toBeNull();
    expect(parseAxisLimit('0.5')).toBe(0.5);
    expect(parseAxisLimit('-3')).toBe(-3);
    expect(parseAxisLimit('1e-4')).toBe(1e-4);
    expect(parseAxisLimit('abc')).toBeUndefined();
    expect(parseAxisLimit('Infinity')).toBeUndefined();
  });

  it('rejects min >= max and non-positive bounds on a log axis', () => {
    expect(axisLimitsError({ min: 1, max: 1 }, false)).toMatch(/less than/);
    expect(axisLimitsError({ min: 2, max: 1 }, false)).toMatch(/less than/);
    expect(axisLimitsError({ min: 0, max: 1 }, false)).toBeNull();
    expect(axisLimitsError({ min: 0, max: 1 }, true)).toMatch(/log/);
    expect(axisLimitsError({ min: null, max: -1 }, true)).toMatch(/log/);
    expect(axisLimitsError({ min: null, max: 5 }, false)).toBeNull();
  });

  it('checks values against half-open limits', () => {
    expect(withinLimits(5, { min: null, max: null })).toBe(true);
    expect(withinLimits(5, { min: 5, max: null })).toBe(true);
    expect(withinLimits(4.9, { min: 5, max: null })).toBe(false);
    expect(withinLimits(10, { min: null, max: 9 })).toBe(false);
    expect(isAutoLimits({ min: null, max: null })).toBe(true);
    expect(isAutoLimits({ min: 0, max: null })).toBe(false);
  });
});
