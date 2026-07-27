import { ManualMonotonicClock } from './clock.js';
import { SourceArbiter, type SourceArbiterOptions } from './source-arbiter.js';
import {
  StablePlaybackTimeline,
  type StablePlaybackTimelineOptions,
  type TimelineSignalResult,
} from './stable-playback-timeline.js';
import type {
  RawPlaybackSignal,
  StablePlaybackSnapshot,
} from './types.js';

export interface PlaybackFixtureEntry {
  readonly receivedAtMs: number;
  readonly signal: RawPlaybackSignal;
}

export interface PlaybackFixture {
  readonly sessionId: string;
  readonly entries: readonly PlaybackFixtureEntry[];
}

export interface PlaybackReplayFrame {
  readonly receivedAtMs: number;
  readonly signal: RawPlaybackSignal;
  readonly authoritySourceInstanceId: string | null;
  readonly authorityChanged: boolean;
  readonly timelineResult: TimelineSignalResult | null;
  readonly snapshot: StablePlaybackSnapshot | null;
}

export interface PlaybackReplayResult {
  readonly frames: readonly PlaybackReplayFrame[];
  readonly falseBackwardSteps: number;
  readonly discontinuityCount: number;
  readonly authoritySwitchCount: number;
}

export interface FixtureReplayOptions {
  readonly arbiter?: SourceArbiterOptions;
  readonly timeline?: StablePlaybackTimelineOptions;
}

/** Deterministically replays raw observations without DOM or real timers. */
export function replayPlaybackFixture(
  fixture: PlaybackFixture,
  options: FixtureReplayOptions = {},
): PlaybackReplayResult {
  if (fixture.sessionId.trim().length === 0) throw new TypeError('fixture sessionId is required');
  const clock = new ManualMonotonicClock();
  const arbiter = new SourceArbiter(options.arbiter);
  const timeline = new StablePlaybackTimeline(options.timeline);
  const frames: PlaybackReplayFrame[] = [];
  let authoritySwitchCount = 0;
  let falseBackwardSteps = 0;
  let discontinuityCount = 0;
  let lastPositionMs: number | null = null;
  let lastDiscontinuitySequence = 0;
  let sessionGeneration = 0;
  let activeSessionId = sessionIdForGeneration(fixture.sessionId, sessionGeneration);

  for (const entry of fixture.entries) {
    clock.advanceTo(entry.receivedAtMs);
    const arbitration = arbiter.observe(entry.signal, clock.now());
    if (arbitration.changed && arbitration.previousAuthority !== null) {
      authoritySwitchCount += 1;
    }

    let timelineResult: TimelineSignalResult | null = null;
    if (
      arbitration.sessionCandidateChanged
      && arbitration.signalIsAuthoritative
      && arbiter.isSignalHealthy(entry.signal)
    ) {
      // Media replacement or same-source session epoch change both require a
      // hard session restart so position projection cannot coast on the prior track.
      sessionGeneration += 1;
      activeSessionId = sessionIdForGeneration(fixture.sessionId, sessionGeneration);
      timelineResult = timeline.startSession(activeSessionId, entry.signal, clock.now());
    } else if (arbitration.signalIsAuthoritative && arbiter.isSignalHealthy(entry.signal)) {
      if (!timeline.getAnchor()) {
        timelineResult = timeline.startSession(activeSessionId, entry.signal, clock.now());
      } else if (arbitration.changed) {
        // Same-media source handoff keeps projected continuity.
        timelineResult = timeline.handoffSource(activeSessionId, entry.signal, clock.now());
      } else {
        timelineResult = timeline.ingest(activeSessionId, entry.signal, clock.now());
      }
    } else if (arbitration.reason === 'authority-expired') {
      timelineResult = timeline.markUnavailable(activeSessionId, clock.now());
    }

    const snapshot = timeline.getSnapshot(clock.now());
    if (snapshot) {
      if (
        lastPositionMs !== null
        && snapshot.positionMs < lastPositionMs
        && snapshot.discontinuitySequence === lastDiscontinuitySequence
      ) {
        falseBackwardSteps += 1;
      }
      if (snapshot.discontinuitySequence > lastDiscontinuitySequence) {
        discontinuityCount += snapshot.discontinuitySequence - lastDiscontinuitySequence;
      }
      lastPositionMs = snapshot.positionMs;
      lastDiscontinuitySequence = snapshot.discontinuitySequence;
    }

    frames.push(Object.freeze({
      receivedAtMs: entry.receivedAtMs,
      signal: entry.signal,
      authoritySourceInstanceId: arbitration.authority?.sourceInstanceId ?? null,
      authorityChanged: arbitration.changed,
      timelineResult,
      snapshot,
    }));
  }

  return Object.freeze({
    frames: Object.freeze(frames),
    falseBackwardSteps,
    discontinuityCount,
    authoritySwitchCount,
  });
}

function sessionIdForGeneration(baseSessionId: string, generation: number): string {
  return generation === 0 ? baseSessionId : `${baseSessionId}:${generation}`;
}
