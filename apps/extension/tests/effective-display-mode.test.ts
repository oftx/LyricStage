import { describe, expect, it } from 'vitest';
import {
  NO_DOCUMENT_CAPABILITIES,
  resolveEffectiveDisplayMode,
} from '../src/surface/effective-display-mode.js';

describe('resolveEffectiveDisplayMode', () => {
  it('keeps the wanted mode when the document supports it', () => {
    const full = { hasKaraoke: true, hasLineTiming: true };
    expect(resolveEffectiveDisplayMode('karaoke', full)).toBe('karaoke');
    expect(resolveEffectiveDisplayMode('lrc', full)).toBe('lrc');
    expect(resolveEffectiveDisplayMode('plaintext', full)).toBe('plaintext');
  });

  it('degrades 逐字 to 整行 when word timing is missing', () => {
    expect(resolveEffectiveDisplayMode('karaoke', {
      hasKaraoke: false,
      hasLineTiming: true,
    })).toBe('lrc');
  });

  it('degrades both synced modes to 文本 when line timing is missing', () => {
    const untimed = { hasKaraoke: false, hasLineTiming: false };
    expect(resolveEffectiveDisplayMode('karaoke', untimed)).toBe('plaintext');
    expect(resolveEffectiveDisplayMode('lrc', untimed)).toBe('plaintext');
  });

  it('plaintext intent never upgrades even when timing exists', () => {
    expect(resolveEffectiveDisplayMode('plaintext', {
      hasKaraoke: true,
      hasLineTiming: true,
    })).toBe('plaintext');
  });

  it('no document renders as plaintext', () => {
    expect(resolveEffectiveDisplayMode('karaoke', NO_DOCUMENT_CAPABILITIES))
      .toBe('plaintext');
  });

  // The restore path is pure recomputation: intent is stored, capability is
  // derived per document, so a later word-timed document flips right back.
  it('capability regained restores the original intent', () => {
    const degraded = resolveEffectiveDisplayMode('karaoke', {
      hasKaraoke: false,
      hasLineTiming: true,
    });
    expect(degraded).toBe('lrc');
    const restored = resolveEffectiveDisplayMode('karaoke', {
      hasKaraoke: true,
      hasLineTiming: true,
    });
    expect(restored).toBe('karaoke');
  });
});
