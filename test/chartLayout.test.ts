import { describe, expect, it } from 'vitest';
import { moveItem } from '../src/webview/chartLayout';

describe('chart layout: moving charts', () => {
  it('moves an item to the first, an earlier, a later and the last position', () => {
    const list = ['a', 'b', 'c', 'd'];
    expect(moveItem(list, 2, 0)).toEqual(['c', 'a', 'b', 'd']);
    expect(moveItem(list, 2, 1)).toEqual(['a', 'c', 'b', 'd']);
    expect(moveItem(list, 1, 2)).toEqual(['a', 'c', 'b', 'd']);
    expect(moveItem(list, 0, 3)).toEqual(['b', 'c', 'd', 'a']);
    expect(list).toEqual(['a', 'b', 'c', 'd']);
  });

  it('clamps the target and ignores an unknown source', () => {
    expect(moveItem(['a', 'b'], 0, 9)).toEqual(['b', 'a']);
    expect(moveItem(['a', 'b'], 1, -3)).toEqual(['b', 'a']);
    expect(moveItem(['a', 'b'], -1, 0)).toEqual(['a', 'b']);
  });
});
