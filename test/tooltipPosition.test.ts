import { describe, expect, it } from 'vitest';
import { tooltipPosition } from '../src/webview/dom';

const box = { w: 100, h: 50, boxW: 400, boxH: 200, gap: 10 };

describe('chart tooltip position', () => {
  it('goes beside the cursor on the roomier side, above in the lower half and below in the upper half', () => {
    expect(tooltipPosition({ ...box, x: 50, y: 40 })).toEqual({ left: 60, top: 50 });
    expect(tooltipPosition({ ...box, x: 350, y: 160 })).toEqual({ left: 240, top: 100 });
  });

  it('takes the other side horizontally when the roomier one does not fit, never covering the cursor', () => {
    expect(tooltipPosition({ ...box, boxW: 220, x: 105, y: 40 }).left).toBe(115);
  });

  it('stays inside the area', () => {
    const p = tooltipPosition({ ...box, w: 500, h: 300, x: 10, y: 10 });
    expect(p).toEqual({ left: 0, top: 0 });
  });
});
