/**
 * Display-mode fallback policy.
 *
 * `prefs.displayMode` stores USER INTENT (the last mode the user manually
 * chose; the first-run default counts as chosen). What the player actually
 * renders is the EFFECTIVE mode: intent degraded along the capability chain
 *   逐字 (needs word timing) → 整行 (needs line timing) → 文本 (always).
 * Degradation is never persisted — when a later document regains the
 * capability, the effective mode returns to the user's intent by itself.
 */
import type { SurfaceDisplayMode } from './surface-preferences.js';

export interface LyricDisplayCapabilities {
  /** Document has at least one word-timed karaoke line. */
  readonly hasKaraoke: boolean;
  /** Document has at least one line with usable line timing. */
  readonly hasLineTiming: boolean;
}

/** No document bound: only plaintext can render (nothing timed to sync). */
export const NO_DOCUMENT_CAPABILITIES: LyricDisplayCapabilities = Object.freeze({
  hasKaraoke: false,
  hasLineTiming: false,
});

export function resolveEffectiveDisplayMode(
  wanted: SurfaceDisplayMode,
  capabilities: LyricDisplayCapabilities,
): SurfaceDisplayMode {
  if (wanted === 'plaintext') return 'plaintext';
  if (!capabilities.hasLineTiming) return 'plaintext';
  if (wanted === 'karaoke' && !capabilities.hasKaraoke) return 'lrc';
  return wanted;
}
