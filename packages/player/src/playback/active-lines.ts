import type {
  LyricTimeIndex,
  LyricTimeIndexEntry,
} from "../domain/time-index.js";
import type { LyricLine } from "../domain/types.js";

class ImmutableSet<T> implements ReadonlySet<T> {
  readonly #values: Set<T>;

  constructor(values: Iterable<T>) {
    this.#values = new Set(values);
    Object.freeze(this);
  }

  get size(): number {
    return this.#values.size;
  }

  has(value: T): boolean {
    return this.#values.has(value);
  }

  forEach(
    callbackfn: (value: T, value2: T, set: ReadonlySet<T>) => void,
    thisArg?: unknown,
  ): void {
    for (const value of this.#values) {
      callbackfn.call(thisArg, value, value, this);
    }
  }

  entries(): SetIterator<[T, T]> {
    return this.#values.entries();
  }

  keys(): SetIterator<T> {
    return this.#values.keys();
  }

  values(): SetIterator<T> {
    return this.#values.values();
  }

  [Symbol.iterator](): SetIterator<T> {
    return this.#values[Symbol.iterator]();
  }

  get [Symbol.toStringTag](): string {
    return "Set";
  }
}

/** Creates a snapshot set without exposing a mutable Set instance. */
export function createImmutableSet<T>(values: Iterable<T>): ReadonlySet<T> {
  return new ImmutableSet(values);
}

export interface ActiveLineSelection {
  readonly entries: readonly LyricTimeIndexEntry[];
  readonly lines: readonly LyricLine[];
  /** Canonical document/source order, independent from the index's time order. */
  readonly orderedLineIds: readonly string[];
  readonly lineIds: ReadonlySet<string>;
}

/** Selects every half-open active interval at the callback clock. */
export function selectActiveLines(
  timeIndex: LyricTimeIndex,
  callbackPlaybackPositionMs: number,
): ActiveLineSelection {
  const entries = Object.freeze([
    ...timeIndex.findActiveAt(callbackPlaybackPositionMs),
  ]);
  const lines = Object.freeze(entries.map((entry) => entry.line));
  const orderedLineIds = Object.freeze(lines.map((line) => line.id));

  return Object.freeze({
    entries,
    lines,
    orderedLineIds,
    lineIds: createImmutableSet(orderedLineIds),
  });
}
