export const lyricsFontWeightTiers = Object.freeze([1, 2, 3, 4, 5] as const);

export type LyricsFontWeightTier = (typeof lyricsFontWeightTiers)[number];

export const DEFAULT_LYRICS_FONT_WEIGHT_TIER: LyricsFontWeightTier = 3;

export function isLyricsFontWeightTier(
  value: unknown,
): value is LyricsFontWeightTier {
  return (lyricsFontWeightTiers as readonly unknown[]).includes(value);
}
