export const lyricsLayoutProfiles = Object.freeze([
  "auto",
  "extra-large",
  "large",
  "regular",
  "narrow",
  "compact",
  "extra-compact",
] as const);

export type LyricsLayoutProfile = (typeof lyricsLayoutProfiles)[number];

export function isLyricsLayoutProfile(
  value: unknown,
): value is LyricsLayoutProfile {
  return (lyricsLayoutProfiles as readonly unknown[]).includes(value);
}
