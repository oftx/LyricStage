import { describe, expect, it } from 'vitest';
import { StablePlaybackTimeline } from '../src/index.js';
import { signal } from './helpers.js';

describe('StablePlaybackTimeline', () => {
  it('projects playing state and freezes paused and buffering states', () => {
    const timeline = new StablePlaybackTimeline();
    timeline.startSession('session-1', signal({ positionMs: 10_000 }), 0);
    expect(timeline.getSnapshot(500)?.positionMs).toBe(10_500);

    timeline.ingest('session-1', signal({
      producerSequence: 2,
      capturedAtMs: 500,
      positionMs: 10_500,
      playbackState: 'buffering',
      eventKind: 'buffer-start',
    }), 500);
    expect(timeline.getSnapshot(5_000)?.positionMs).toBe(10_500);

    timeline.ingest('session-1', signal({
      producerSequence: 3,
      capturedAtMs: 5_000,
      positionMs: 10_500,
      playbackState: 'paused',
      eventKind: 'pause',
    }), 5_000);
    expect(timeline.getSnapshot(10_000)?.positionMs).toBe(10_500);
  });

  it('does not manufacture playback progress when a pause observation arrives', () => {
    const timeline = new StablePlaybackTimeline();
    timeline.startSession('session-1', signal({ positionMs: 10_000 }), 0);
    timeline.ingest('session-1', signal({
      producerSequence: 2,
      capturedAtMs: 1_000,
      positionMs: 10_700,
      playbackState: 'paused',
      eventKind: 'pause',
    }), 1_000);
    expect(timeline.getSnapshot(5_000)?.positionMs).toBe(11_000);
  });

  it('does not publish an isolated reverse outlier', () => {
    const timeline = new StablePlaybackTimeline();
    timeline.startSession('session-1', signal({ positionMs: 10_000 }), 0);
    const result = timeline.ingest('session-1', signal({
      producerSequence: 2,
      capturedAtMs: 1_000,
      positionMs: 5_000,
    }), 1_000);
    expect(result.status).toBe('staged-discontinuity');
    expect(timeline.getSnapshot(1_000)?.positionMs).toBe(11_000);
    expect(timeline.getSnapshot(1_500)?.positionMs).toBe(11_500);
  });

  it('slews small persistent phase errors without moving backwards', () => {
    const timeline = new StablePlaybackTimeline({ deadbandMs: 50 });
    timeline.startSession('session-1', signal({ positionMs: 10_000 }), 0);
    timeline.ingest('session-1', signal({
      producerSequence: 2,
      capturedAtMs: 1_000,
      positionMs: 10_500,
    }), 1_000);
    const atOneSecond = timeline.getSnapshot(1_000)?.positionMs ?? -1;
    const atTwoSeconds = timeline.getSnapshot(2_000)?.positionMs ?? -1;
    expect(atOneSecond).toBe(11_000);
    expect(atTwoSeconds).toBeGreaterThan(atOneSecond);
    expect(atTwoSeconds).toBeLessThan(12_000);
  });

  it('commits explicit seek immediately but requires two unexplained large jumps', () => {
    const timeline = new StablePlaybackTimeline();
    timeline.startSession('session-1', signal({ positionMs: 10_000 }), 0);
    const first = timeline.ingest('session-1', signal({
      producerSequence: 2,
      capturedAtMs: 100,
      positionMs: 30_000,
    }), 100);
    expect(first.status).toBe('staged-discontinuity');
    const second = timeline.ingest('session-1', signal({
      producerSequence: 3,
      capturedAtMs: 200,
      positionMs: 30_100,
    }), 200);
    expect(second.reason).toBe('confirmed-large-jump');
    expect(second.discontinuity?.kind).toBe('unknown');
    expect(timeline.getSnapshot(200)?.positionMs).toBe(30_100);

    const seek = timeline.ingest('session-1', signal({
      producerSequence: 4,
      capturedAtMs: 300,
      positionMs: 5_000,
      eventKind: 'seek-end',
    }), 300);
    expect(seek.reason).toBe('confirmed-seek');
    expect(timeline.getSnapshot(300)?.positionMs).toBe(5_000);
  });

  it('rejects old session and stale source signals', () => {
    const timeline = new StablePlaybackTimeline();
    timeline.startSession('session-1', signal(), 0);
    expect(timeline.ingest('old-session', signal({ producerSequence: 2 }), 100).reason)
      .toBe('stale-session');
    expect(timeline.ingest('session-1', signal({
      producerSequence: 3,
      sourceInstanceId: 'old-media',
    }), 100).reason).toBe('stale-source');
  });

  it('allows at most one recovery re-anchor per hidden epoch', () => {
    const timeline = new StablePlaybackTimeline();
    timeline.startSession('session-1', signal({ positionMs: 10_000 }), 0);
    timeline.ingest('session-1', signal({
      producerSequence: 2,
      capturedAtMs: 1_000,
      positionMs: 11_000,
      eventKind: 'visibility-hidden',
    }), 1_000);
    const firstVisible = timeline.ingest('session-1', signal({
      producerSequence: 3,
      capturedAtMs: 10_000,
      positionMs: 25_000,
      eventKind: 'visibility-visible',
    }), 10_000);
    expect(firstVisible.reason).toBe('resume-reanchor');

    const duplicateVisible = timeline.ingest('session-1', signal({
      producerSequence: 4,
      capturedAtMs: 10_100,
      positionMs: 40_000,
      eventKind: 'visibility-visible',
    }), 10_100);
    expect(duplicateVisible.reason).toBe('large-jump-candidate');
  });

  it('freezes when the selected source expires', () => {
    const timeline = new StablePlaybackTimeline();
    timeline.startSession('session-1', signal({ positionMs: 10_000 }), 0);
    const result = timeline.markUnavailable('session-1', 1_000);
    expect(result.reason).toBe('source-unavailable');
    expect(timeline.getSnapshot(10_000)).toMatchObject({
      positionMs: 11_000,
      playbackState: 'unavailable',
      available: false,
    });
  });

  it('treats duration as a hint rather than clamping published time backwards', () => {
    const timeline = new StablePlaybackTimeline();
    timeline.startSession('session-1', signal({ positionMs: 10_000, durationMs: 5_000 }), 0);
    expect(timeline.getSnapshot(1_000)?.positionMs).toBe(11_000);
  });

  it('retains a known duration through an intermittent zero duration sample', () => {
    const timeline = new StablePlaybackTimeline();
    timeline.startSession('session-1', signal({ durationMs: 180_000 }), 0);
    timeline.ingest('session-1', signal({
      producerSequence: 2,
      capturedAtMs: 1_000,
      positionMs: 1_000,
      durationMs: 0,
      eventKind: 'metadata',
    }), 1_000);
    expect(timeline.getSnapshot(1_000)?.durationMs).toBe(180_000);
  });

  it('recognizes terminal-to-start replay as a loop discontinuity', () => {
    const timeline = new StablePlaybackTimeline();
    timeline.startSession('session-1', signal({
      positionMs: 179_000,
      playbackState: 'ended',
      eventKind: 'ended',
    }), 0);
    const result = timeline.ingest('session-1', signal({
      producerSequence: 2,
      capturedAtMs: 100,
      positionMs: 0,
      playbackState: 'playing',
      eventKind: 'play',
    }), 100);
    expect(result.reason).toBe('confirmed-loop');
    expect(result.discontinuity?.kind).toBe('loop');
  });

  it('preserves discontinuity ordering across session replacement', () => {
    const timeline = new StablePlaybackTimeline();
    timeline.startSession('session-1', signal({ positionMs: 10_000 }), 0);
    const replacement = timeline.startSession('session-2', signal({
      producerSequence: 2,
      sessionCandidateId: 'candidate-2',
      positionMs: 0,
      eventKind: 'media-candidate',
    }), 100);
    expect(replacement.discontinuity).toMatchObject({
      sequence: 1,
      kind: 'session-change',
    });
    expect(timeline.getSnapshot(100)?.discontinuitySequence).toBe(1);
  });
});
