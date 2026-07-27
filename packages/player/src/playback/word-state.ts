import type { LyricLine, LyricTrack, LyricWord } from "../domain/types.js";
import { createImmutableSet } from "./active-lines.js";

export const wordTrackNames = Object.freeze([
  "foreground",
  "foregroundPronunciation",
  "background",
  "backgroundPronunciation",
] as const);

export type WordTrackName = (typeof wordTrackNames)[number];
export type WordTimingState = "untimed" | "future" | "active" | "sung";
export type ActiveWordIdsByLine = ReadonlyMap<string, ReadonlySet<string>>;

export interface WordIdsByTrack {
  readonly foreground: ActiveWordIdsByLine;
  readonly foregroundPronunciation: ActiveWordIdsByLine;
  readonly background: ActiveWordIdsByLine;
  readonly backgroundPronunciation: ActiveWordIdsByLine;
}

class ImmutableMap<K, V> implements ReadonlyMap<K, V> {
  readonly #values: Map<K, V>;

  constructor(values: Iterable<readonly [K, V]>) {
    this.#values = new Map(values);
    Object.freeze(this);
  }

  get size(): number {
    return this.#values.size;
  }

  get(key: K): V | undefined {
    return this.#values.get(key);
  }

  has(key: K): boolean {
    return this.#values.has(key);
  }

  forEach(
    callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void,
    thisArg?: unknown,
  ): void {
    for (const [key, value] of this.#values) {
      callbackfn.call(thisArg, value, key, this);
    }
  }

  entries(): MapIterator<[K, V]> {
    return this.#values.entries();
  }

  keys(): MapIterator<K> {
    return this.#values.keys();
  }

  values(): MapIterator<V> {
    return this.#values.values();
  }

  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.#values[Symbol.iterator]();
  }

  get [Symbol.toStringTag](): string {
    return "Map";
  }
}

function createImmutableMap<K, V>(
  values: Iterable<readonly [K, V]>,
): ReadonlyMap<K, V> {
  return new ImmutableMap(values);
}

/** Classifies timing only; paint progress and lift belong to later phases. */
export function classifyWordAt(
  word: LyricWord,
  wordPlaybackPositionMs: number,
): WordTimingState {
  const beginMs = word.begin.valueMs;
  const endMs = word.end.valueMs;

  if (
    beginMs === null ||
    endMs === null ||
    !Number.isFinite(beginMs) ||
    !Number.isFinite(endMs) ||
    !Number.isFinite(wordPlaybackPositionMs) ||
    endMs < beginMs
  ) {
    return "untimed";
  }
  if (wordPlaybackPositionMs < beginMs) return "future";
  if (wordPlaybackPositionMs >= endMs) return "sung";
  return "active";
}

function collectActiveWordIds(
  lines: readonly LyricLine[],
  trackName: WordTrackName,
  wordPlaybackPositionMs: number,
): ActiveWordIdsByLine {
  const byLine: Array<readonly [string, ReadonlySet<string>]> = [];

  for (const line of lines) {
    if (line.tracks === null) continue;
    const track: LyricTrack | undefined = line.tracks[trackName];
    if (!track) continue;

    const activeWordIds = track.words
      .filter(
        (word) => classifyWordAt(word, wordPlaybackPositionMs) === "active",
      )
      .map((word) => word.id);
    if (activeWordIds.length > 0) {
      byLine.push([line.id, createImmutableSet(activeWordIds)]);
    }
  }

  return createImmutableMap(byLine);
}

/** Builds four independent active-word maps and scans active lines only. */
export function createWordIdsByTrack(
  activeLines: readonly LyricLine[],
  wordPlaybackPositionMs: number,
): WordIdsByTrack {
  return Object.freeze({
    foreground: collectActiveWordIds(
      activeLines,
      "foreground",
      wordPlaybackPositionMs,
    ),
    foregroundPronunciation: collectActiveWordIds(
      activeLines,
      "foregroundPronunciation",
      wordPlaybackPositionMs,
    ),
    background: collectActiveWordIds(
      activeLines,
      "background",
      wordPlaybackPositionMs,
    ),
    backgroundPronunciation: collectActiveWordIds(
      activeLines,
      "backgroundPronunciation",
      wordPlaybackPositionMs,
    ),
  });
}
