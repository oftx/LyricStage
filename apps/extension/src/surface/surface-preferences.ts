/**
 * Lyric-window display preferences (userscript-aligned discrete tiers).
 * Persisted in localStorage; applied via player-core public APIs.
 */

import {
  isLyricsFontWeightTier,
  lyricsFontWeightTiers,
  lyricsLayoutProfiles,
  type LyricsFontWeightTier,
  type LyricsLayoutProfile,
} from '@lyric-stage/player';

export type SurfaceDisplayMode = 'plaintext' | 'lrc' | 'karaoke';
export type SurfaceBackgroundMode = 'solid' | 'cover';
export type SurfaceTheme = 'light' | 'dark' | 'system';

/** Layout tiers exposed in UI (exclude auto). */
export type SurfaceLayoutProfile = Exclude<LyricsLayoutProfile, 'auto'>;

export type SurfacePreferences = {
  readonly fontWeightTier: LyricsFontWeightTier;
  /** Weight tier for the plaintext poem view; independent of fontWeightTier. */
  readonly plaintextFontWeightTier: LyricsFontWeightTier;
  readonly layoutProfile: SurfaceLayoutProfile;
  readonly displayMode: SurfaceDisplayMode;
  readonly backgroundMode: SurfaceBackgroundMode;
  readonly theme: SurfaceTheme;
  readonly translationVisible: boolean;
  readonly pronunciationVisible: boolean;
  /** Show header + status bar (debug chrome); off by default. */
  readonly debugChrome: boolean;
  /** Fullscreen gets its own typography (viewing distance differs). */
  readonly fullscreenFontWeightTier: LyricsFontWeightTier;
  readonly fullscreenLayoutProfile: SurfaceLayoutProfile;
};

export const LAYOUT_PROFILE_TIERS = Object.freeze([
  'extra-compact',
  'compact',
  'narrow',
  'regular',
  'large',
  'extra-large',
] as const satisfies readonly SurfaceLayoutProfile[]);

export const FONT_WEIGHT_TIERS = lyricsFontWeightTiers;

export const DEFAULT_SURFACE_PREFERENCES: SurfacePreferences = Object.freeze({
  // User-set defaults (fourth review round): weight 4, size tier 2.
  fontWeightTier: 4,
  // Tier 1 (400) preserves the accepted "one step lighter" plaintext tuning.
  plaintextFontWeightTier: 1,
  layoutProfile: 'compact',
  displayMode: 'karaoke',
  backgroundMode: 'cover',
  theme: 'system',
  translationVisible: false,
  pronunciationVisible: false,
  debugChrome: false,
  // Fullscreen defaults (user-set): weight 4, size tier 5.
  fullscreenFontWeightTier: 4,
  fullscreenLayoutProfile: 'large',
});

const PREF_STORAGE_KEY = 'lyric-stage.surface.display-prefs.v2';
const LEGACY_PREF_KEYS = [
  'lyric-stage.surface.display-prefs.v1',
  'lyric-stage.surface.secondary-prefs',
] as const;

export function isSurfaceDisplayMode(value: unknown): value is SurfaceDisplayMode {
  return value === 'plaintext' || value === 'lrc' || value === 'karaoke';
}

export function isSurfaceBackgroundMode(value: unknown): value is SurfaceBackgroundMode {
  return value === 'solid' || value === 'cover';
}

export function isSurfaceTheme(value: unknown): value is SurfaceTheme {
  return value === 'light' || value === 'dark' || value === 'system';
}

export function isSurfaceLayoutProfile(value: unknown): value is SurfaceLayoutProfile {
  return (LAYOUT_PROFILE_TIERS as readonly string[]).includes(value as string)
    && value !== 'auto'
    && (lyricsLayoutProfiles as readonly string[]).includes(value as string);
}

export function layoutProfileLabel(profile: SurfaceLayoutProfile): string {
  const index = LAYOUT_PROFILE_TIERS.indexOf(profile);
  return String(index >= 0 ? index + 1 : 4);
}

export function resolveThemeAppearance(
  theme: SurfaceTheme,
  matchMediaFn: (query: string) => { matches: boolean } = (q) => window.matchMedia(q),
): 'light' | 'dark' {
  if (theme === 'light' || theme === 'dark') return theme;
  return matchMediaFn('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function migrateLegacy(raw: string): Partial<SurfacePreferences> {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // v1 continuous → nearest tiers
    const plaintextFontWeightTier = isLyricsFontWeightTier(parsed.plaintextFontWeightTier)
      ? parsed.plaintextFontWeightTier
      : undefined;
    const fontWeightTier = isLyricsFontWeightTier(parsed.fontWeightTier)
      ? parsed.fontWeightTier
      : typeof parsed.fontWeight === 'number'
        ? (Math.min(5, Math.max(1, Math.round(parsed.fontWeight))) as LyricsFontWeightTier)
        : undefined;
    const layoutProfile = isSurfaceLayoutProfile(parsed.layoutProfile)
      ? parsed.layoutProfile
      : typeof parsed.fontScale === 'number'
        ? scaleToLayoutProfile(parsed.fontScale)
        : undefined;
    return {
      ...(fontWeightTier !== undefined ? { fontWeightTier } : {}),
      ...(plaintextFontWeightTier !== undefined ? { plaintextFontWeightTier } : {}),
      ...(layoutProfile !== undefined ? { layoutProfile } : {}),
      ...(isSurfaceDisplayMode(parsed.displayMode) ? { displayMode: parsed.displayMode } : {}),
      ...(isSurfaceBackgroundMode(parsed.backgroundMode)
        ? { backgroundMode: parsed.backgroundMode }
        : {}),
      ...(isSurfaceTheme(parsed.theme) ? { theme: parsed.theme } : {}),
      ...(typeof parsed.translationVisible === 'boolean'
        ? { translationVisible: parsed.translationVisible }
        : typeof parsed.translation === 'boolean'
          ? { translationVisible: parsed.translation }
          : {}),
      ...(typeof parsed.pronunciationVisible === 'boolean'
        ? { pronunciationVisible: parsed.pronunciationVisible }
        : typeof parsed.pronunciation === 'boolean'
          ? { pronunciationVisible: parsed.pronunciation }
          : {}),
    };
  } catch {
    return {};
  }
}

/** Map old continuous scale (~0.7–1.6) onto discrete layout tiers. */
function scaleToLayoutProfile(scale: number): SurfaceLayoutProfile {
  if (scale < 0.8) return 'extra-compact';
  if (scale < 0.9) return 'compact';
  if (scale < 0.98) return 'narrow';
  if (scale < 1.15) return 'regular';
  if (scale < 1.4) return 'large';
  return 'extra-large';
}

export function loadSurfacePreferences(): SurfacePreferences {
  try {
    const raw = localStorage.getItem(PREF_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SurfacePreferences>;
      return normalizePrefs(parsed);
    }
    for (const key of LEGACY_PREF_KEYS) {
      const legacy = localStorage.getItem(key);
      if (legacy) return normalizePrefs(migrateLegacy(legacy));
    }
  } catch {
    // ignore
  }
  return { ...DEFAULT_SURFACE_PREFERENCES };
}

function normalizePrefs(parsed: Partial<SurfacePreferences>): SurfacePreferences {
  return {
    fontWeightTier: isLyricsFontWeightTier(parsed.fontWeightTier)
      ? parsed.fontWeightTier
      : DEFAULT_SURFACE_PREFERENCES.fontWeightTier,
    plaintextFontWeightTier: isLyricsFontWeightTier(parsed.plaintextFontWeightTier)
      ? parsed.plaintextFontWeightTier
      : DEFAULT_SURFACE_PREFERENCES.plaintextFontWeightTier,
    layoutProfile: isSurfaceLayoutProfile(parsed.layoutProfile)
      ? parsed.layoutProfile
      : DEFAULT_SURFACE_PREFERENCES.layoutProfile,
    displayMode: isSurfaceDisplayMode(parsed.displayMode)
      ? parsed.displayMode
      : DEFAULT_SURFACE_PREFERENCES.displayMode,
    backgroundMode: isSurfaceBackgroundMode(parsed.backgroundMode)
      ? parsed.backgroundMode
      : DEFAULT_SURFACE_PREFERENCES.backgroundMode,
    theme: isSurfaceTheme(parsed.theme)
      ? parsed.theme
      : DEFAULT_SURFACE_PREFERENCES.theme,
    translationVisible: typeof parsed.translationVisible === 'boolean'
      ? parsed.translationVisible
      : DEFAULT_SURFACE_PREFERENCES.translationVisible,
    pronunciationVisible: typeof parsed.pronunciationVisible === 'boolean'
      ? parsed.pronunciationVisible
      : DEFAULT_SURFACE_PREFERENCES.pronunciationVisible,
    debugChrome: typeof parsed.debugChrome === 'boolean'
      ? parsed.debugChrome
      : DEFAULT_SURFACE_PREFERENCES.debugChrome,
    fullscreenFontWeightTier: isLyricsFontWeightTier(parsed.fullscreenFontWeightTier)
      ? parsed.fullscreenFontWeightTier
      : DEFAULT_SURFACE_PREFERENCES.fullscreenFontWeightTier,
    fullscreenLayoutProfile: isSurfaceLayoutProfile(parsed.fullscreenLayoutProfile)
      ? parsed.fullscreenLayoutProfile
      : DEFAULT_SURFACE_PREFERENCES.fullscreenLayoutProfile,
  };
}

export function saveSurfacePreferences(prefs: SurfacePreferences): void {
  try {
    localStorage.setItem(PREF_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    // ignore quota / private mode
  }
}
