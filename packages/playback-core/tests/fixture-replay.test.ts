import { describe, expect, it } from 'vitest';
import { replayPlaybackFixture } from '../src/index.js';
import { signal } from './helpers.js';

describe('fixture replay harness', () => {
  it('reports no false reverse output across jitter, buffering and a confirmed seek', () => {
    const result = replayPlaybackFixture({
      sessionId: 'session-1',
      entries: [
        { receivedAtMs: 0, signal: signal({ producerSequence: 1, positionMs: 0 }) },
        { receivedAtMs: 1_000, signal: signal({
          producerSequence: 2,
          capturedAtMs: 1_000,
          positionMs: 1_050,
        }) },
        { receivedAtMs: 2_000, signal: signal({
          producerSequence: 3,
          capturedAtMs: 2_000,
          positionMs: 1_900,
        }) },
        { receivedAtMs: 2_100, signal: signal({
          producerSequence: 4,
          capturedAtMs: 2_100,
          positionMs: 1_900,
          playbackState: 'buffering',
          eventKind: 'buffer-start',
        }) },
        { receivedAtMs: 5_000, signal: signal({
          producerSequence: 5,
          capturedAtMs: 5_000,
          positionMs: 20_000,
          eventKind: 'seek-end',
        }) },
      ],
    });
    expect(result.falseBackwardSteps).toBe(0);
    expect(result.discontinuityCount).toBe(1);
    expect(result.authoritySwitchCount).toBe(0);
  });

  it('does not let a tolerated source-lost observation replace the stable anchor', () => {
    const result = replayPlaybackFixture({
      sessionId: 'session-1',
      entries: [
        { receivedAtMs: 0, signal: signal({ producerSequence: 1, positionMs: 10_000 }) },
        { receivedAtMs: 1_000, signal: signal({
          producerSequence: 2,
          capturedAtMs: 1_000,
          positionMs: null,
          playbackState: 'unavailable',
          eventKind: 'source-lost',
          confidence: 0,
        }) },
      ],
    });
    expect(result.frames[1]?.timelineResult).toBeNull();
    expect(result.frames[1]?.snapshot?.playbackState).toBe('playing');
    expect(result.frames[1]?.snapshot?.positionMs).toBe(11_000);
  });

  it('starts a fresh stable session when one source instance reports new media', () => {
    const result = replayPlaybackFixture({
      sessionId: 'session-1',
      entries: [
        { receivedAtMs: 0, signal: signal({ producerSequence: 1, positionMs: 50_000 }) },
        { receivedAtMs: 1_000, signal: signal({
          producerSequence: 2,
          sessionCandidateId: 'candidate-2',
          capturedAtMs: 1_000,
          positionMs: 0,
          eventKind: 'media-candidate',
        }) },
      ],
    });
    expect(result.frames[1]?.timelineResult?.reason).toBe('session-started');
    expect(result.frames[1]?.snapshot?.positionMs).toBe(0);
    expect(result.frames[1]?.snapshot?.sessionId).toBe('session-1:1');
  });

  it('starts a new session when authority is replaced by different media', () => {
    const result = replayPlaybackFixture({
      sessionId: 'session-1',
      entries: [
        {
          receivedAtMs: 0,
          signal: signal({
            producerSequence: 1,
            sourceInstanceId: 'song-a',
            sessionCandidateId: 'candidate-a',
            positionMs: 50_000,
          }),
        },
        {
          receivedAtMs: 1_000,
          signal: signal({
            producerSequence: 2,
            sourceInstanceId: 'song-b',
            sessionCandidateId: 'candidate-b',
            positionMs: 0,
            capturedAtMs: 1_000,
            eventKind: 'media-candidate',
          }),
        },
        {
          receivedAtMs: 1_250,
          signal: signal({
            producerSequence: 3,
            sourceInstanceId: 'song-b',
            sessionCandidateId: 'candidate-b',
            positionMs: 250,
            capturedAtMs: 1_250,
          }),
        },
      ],
    });
    expect(result.frames[2]?.timelineResult?.reason).toBe('session-started');
    expect(result.frames[2]?.snapshot?.positionMs).toBe(250);
    expect(result.frames[2]?.snapshot?.sessionId).toBe('session-1:1');
    expect(result.falseBackwardSteps).toBe(0);
  });
});
