import { describe, expect, it } from 'vitest';
import { parseRawPlaybackSignal } from '../src/index.js';
import { signal } from './helpers.js';

describe('raw playback signal validation', () => {
  it('accepts the complete versioned core signal shape', () => {
    const input = signal();
    expect(parseRawPlaybackSignal(input)).toEqual({ success: true, value: input });
  });

  it('rejects unknown fields and impossible numeric values', () => {
    const result = parseRawPlaybackSignal({
      ...signal(),
      confidence: 1.2,
      capturedAtMs: Number.NaN,
      pageText: 'must never cross the boundary',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues.map((issue) => issue.path)).toEqual(expect.arrayContaining([
        '$.confidence',
        '$.capturedAtMs',
        '$.pageText',
      ]));
    }
  });

  it('rejects malformed nested media identities', () => {
    const result = parseRawPlaybackSignal({
      ...signal(),
      mediaIdentity: { platform: 'fixture', externalId: '', token: 'secret' },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues.map((issue) => issue.path)).toEqual(expect.arrayContaining([
        '$.mediaIdentity.externalId',
        '$.mediaIdentity.token',
      ]));
    }
  });
});
