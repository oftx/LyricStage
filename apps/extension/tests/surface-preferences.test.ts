// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  FONT_WEIGHT_TIERS,
  isSurfaceLayoutProfile,
  isSurfaceTheme,
  LAYOUT_PROFILE_TIERS,
  layoutProfileLabel,
  resolveThemeAppearance,
} from '../src/surface/surface-preferences.js';

describe('surface preferences', () => {
  it('exposes discrete weight and layout tiers', () => {
    expect(FONT_WEIGHT_TIERS).toEqual([1, 2, 3, 4, 5]);
    expect(LAYOUT_PROFILE_TIERS).toContain('regular');
    expect(LAYOUT_PROFILE_TIERS).toContain('extra-large');
    expect(isSurfaceLayoutProfile('regular')).toBe(true);
    expect(isSurfaceLayoutProfile('auto')).toBe(false);
    expect(layoutProfileLabel('regular')).toBe('4');
  });

  it('resolves system theme without colliding with chrome attribute', () => {
    expect(isSurfaceTheme('system')).toBe(true);
    expect(resolveThemeAppearance('light')).toBe('light');
    expect(resolveThemeAppearance('dark')).toBe('dark');
    expect(
      resolveThemeAppearance('system', () => ({ matches: true })),
    ).toBe('dark');
    expect(
      resolveThemeAppearance('system', () => ({ matches: false })),
    ).toBe('light');
  });
});


describe('plaintext font weight tier preference', () => {
  it('defaults to tier 1, round-trips valid values, rejects invalid', async () => {
    const {
      DEFAULT_SURFACE_PREFERENCES,
      loadSurfacePreferences,
      saveSurfacePreferences,
    } = await import('../src/surface/surface-preferences.js');
    expect(DEFAULT_SURFACE_PREFERENCES.plaintextFontWeightTier).toBe(1);
    saveSurfacePreferences({
      ...DEFAULT_SURFACE_PREFERENCES,
      plaintextFontWeightTier: 4,
    });
    expect(loadSurfacePreferences().plaintextFontWeightTier).toBe(4);
    // Invalid persisted values fall back to the default.
    localStorage.setItem(
      'lyric-stage.surface.display-prefs.v2',
      JSON.stringify({ ...DEFAULT_SURFACE_PREFERENCES, plaintextFontWeightTier: 9 }),
    );
    expect(loadSurfacePreferences().plaintextFontWeightTier).toBe(1);
    localStorage.clear();
  });
});
