import type { RawPlaybackSignal } from '@lyric-stage/playback-core';

/** Element-like surface used by adapters (duck-typed for tests). */
export interface ElementPort {
  getAttribute(name: string): string | null;
  readonly textContent?: string | null;
  readonly classList?: { contains(token: string): boolean };
  querySelector?(selectors: string): ElementPort | null;
  closest?(selectors: string): ElementPort | null;
}

export interface MediaElementPort {
  readonly currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly seeking: boolean;
  readonly playbackRate: number;
  readonly readyState?: number;
  readonly currentSrc: string;
  readonly src: string;
  readonly clientWidth?: number;
  readonly clientHeight?: number;
  readonly isConnected: boolean;
  getAttribute(name: string): string | null;
  closest?(selectors: string): ElementPort | null;
}

/** Minimal DOM port so adapters stay testable without a real page. */
export interface DocumentPort {
  readonly location: { readonly href: string; readonly pathname: string; readonly search: string };
  querySelectorAll(selectors: string): Iterable<MediaElementPort | ElementPort>;
  querySelector(selectors: string): ElementPort | null;
}

export interface AdapterClock {
  now(): number;
}

/**
 * Cached MAIN-world (or other privileged) playback clock sample.
 * Used when isolated content cannot see the page-owned media node.
 * Never derived from progress-bar/DOM clock scraping.
 */
export interface PageClockSample {
  readonly positionMs: number | null;
  readonly durationMs: number | null;
  readonly playbackState: RawPlaybackSignal['playbackState'];
  readonly rate: number;
  readonly seeking: boolean;
  readonly sourceKind: Extract<RawPlaybackSignal['sourceKind'], 'media-element' | 'platform-api'>;
  readonly confidence: number;
  /** Optional identity hint from src/platform API; may be null. */
  readonly mediaExternalIdHint: string | null;
  readonly capturedAtMs: number;
}

export interface PageClockPort {
  /** Latest trusted page-clock sample, or null before first successful read. */
  getLatestSample(): PageClockSample | null;
}

export type RawSignalListener = (signal: RawPlaybackSignal) => void;

export interface RawSignalAdapter {
  start(listener: RawSignalListener): void;
  stop(): void;
  sample(): RawPlaybackSignal | null;
}
