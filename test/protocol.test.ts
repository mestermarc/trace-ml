import { describe, expect, it } from 'vitest';
import { MAX_UI_STATE_BYTES, parseWebviewMessage } from '../src/protocol';

describe('webview message validation', () => {
  it('accepts a saveState object', () => {
    expect(parseWebviewMessage({ type: 'saveState', state: { version: 1, plot: { metrics: ['val/auc'] } } })).toEqual({
      type: 'saveState',
      state: { version: 1, plot: { metrics: ['val/auc'] } },
    });
  });

  it('rejects malformed or oversized saveState', () => {
    expect(parseWebviewMessage({ type: 'saveState', state: 'x' })).toBeNull();
    expect(parseWebviewMessage({ type: 'saveState', state: [1, 2] })).toBeNull();
    expect(parseWebviewMessage({ type: 'saveState' })).toBeNull();
    expect(parseWebviewMessage({ type: 'saveState', state: { big: 'x'.repeat(MAX_UI_STATE_BYTES) } })).toBeNull();
  });

  it('rejects unknown messages and file names outside the fixed list', () => {
    expect(parseWebviewMessage({ type: 'deleteEverything' })).toBeNull();
    expect(parseWebviewMessage({ type: 'openFile', runKey: 'k', file: '../../etc/passwd' })).toBeNull();
    expect(parseWebviewMessage({ type: 'openFile', runKey: 'k', file: 'logs/run.log' })).toEqual({ type: 'openFile', runKey: 'k', file: 'logs/run.log' });
  });
});
