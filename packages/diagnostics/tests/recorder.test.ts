import { describe, expect, it } from 'vitest';
import type { RawPlaybackSignal } from '@lyric-stage/playback-core';
import {
  RawPlaybackSignalRecorder,
  RawSignalDiagnosticSampler,
  type RawPlaybackDiagnosticInput,
} from '../src/index.js';

function input(
  capturedAtMs: number,
  patch: Partial<RawPlaybackDiagnosticInput> = {},
): RawPlaybackDiagnosticInput {
  return {
    capturedAtMs,
    positionMs: capturedAtMs,
    durationMs: 180_000,
    playbackState: 'playing',
    rate: 1,
    seeking: false,
    sourceKind: 'media-element',
    confidence: 1,
    eventKind: 'sample',
    sourceInstanceKey: 'https://private.invalid/audio?token=secret',
    mediaIdentityKey: 'private-song-id',
    ...patch,
  };
}

function signal(capturedAtMs: number, patch: Partial<RawPlaybackSignal> = {}): RawPlaybackSignal {
  return {
    producerInstanceId: 'producer:real',
    producerSequence: capturedAtMs + 1,
    sessionCandidateId: 'session:real',
    sourceInstanceId: 'source:private',
    sourceKind: 'media-element',
    capturedAtMs,
    positionMs: capturedAtMs,
    durationMs: 180_000,
    playbackState: 'playing',
    rate: 1,
    seeking: false,
    mediaIdentity: { platform: 'youtube', externalId: 'private-video-id' },
    confidence: 1,
    eventKind: 'sample',
    ...patch,
  };
}

describe('RawPlaybackSignalRecorder', () => {
  it('is disabled by default and tokenizes identities before retention', () => {
    const recorder = new RawPlaybackSignalRecorder('YouTube', {
      now: () => 0,
      wallNow: () => new Date('2026-07-23T00:00:00.000Z'),
      producerInstanceId: 'fixture-producer',
    });
    expect(recorder.record(input(0))).toBe(false);
    recorder.start();
    recorder.record(input(10));
    recorder.stop();

    const fixture = recorder.createFixture();
    expect(fixture.platformId).toBe('youtube');
    expect(fixture.recording).toBe(false);
    expect(fixture.signals[0]?.sourceInstanceId).toMatch(/^source-/);
    expect(fixture.signals[0]?.mediaInstanceId).toMatch(/^media-/);
    expect(JSON.stringify(fixture)).not.toContain('token=secret');
    expect(JSON.stringify(fixture)).not.toContain('private-song-id');
  });

  it('bounds retained entries and rejects page-text source labels', () => {
    const recorder = new RawPlaybackSignalRecorder('netease', {
      maxEntries: 2,
      maxDurationMs: 100,
      maxBytes: 2_000,
      now: () => 0,
    });
    recorder.start();
    recorder.record(input(0));
    recorder.record(input(100));
    recorder.record(input(200, { sourceEvent: '页面文字 must not pass!' }));
    const fixture = recorder.createFixture();
    expect(fixture.signals.map((entry) => entry.elapsedMs)).toEqual([100, 200]);
    expect(fixture.droppedEntries).toBe(1);
    expect(fixture.signals[1]?.sourceEvent).toBeUndefined();
  });
});

describe('RawSignalDiagnosticSampler', () => {
  it('retains state transitions immediately and ordinary samples at 1 Hz', () => {
    const recorder = new RawPlaybackSignalRecorder('youtube', { now: () => 0 });
    const sampler = new RawSignalDiagnosticSampler(recorder, { heartbeatMs: 1_000 });
    recorder.start();
    expect(sampler.record(signal(0))).toBe(true);
    expect(sampler.record(signal(250))).toBe(false);
    expect(sampler.record(signal(1_000))).toBe(true);
    expect(sampler.record(signal(1_100, {
      playbackState: 'paused',
      eventKind: 'pause',
    }))).toBe(true);
    expect(sampler.record(signal(1_200, {
      playbackState: 'paused',
      eventKind: 'pause',
    }))).toBe(false);

    expect(recorder.createFixture().signals.map((entry) => entry.eventKind)).toEqual([
      'sample', 'sample', 'pause',
    ]);
  });

  it('records position discontinuities immediately between heartbeats', () => {
    const recorder = new RawPlaybackSignalRecorder('qqmusic', { now: () => 0 });
    const sampler = new RawSignalDiagnosticSampler(recorder, {
      heartbeatMs: 1_000,
      positionJumpThresholdMs: 750,
    });
    recorder.start();
    expect(sampler.record(signal(0))).toBe(true);
    // Continuous playback between heartbeats stays coalesced.
    expect(sampler.record(signal(250))).toBe(false);
    // A sub-heartbeat backward seek must not alias into silence.
    expect(sampler.record(signal(400, { positionMs: 42_000 }))).toBe(true);
    // Forward jump beyond dead-reckoning also records immediately.
    expect(sampler.record(signal(600, { positionMs: 90_000 }))).toBe(true);
    // Continuation from the new anchor coalesces again.
    expect(sampler.record(signal(850, { positionMs: 90_250 }))).toBe(false);
    expect(recorder.createFixture().signals).toHaveLength(3);
  });

  it('treats paused position drift as a jump only beyond the threshold', () => {
    const recorder = new RawPlaybackSignalRecorder('qqmusic', { now: () => 0 });
    const sampler = new RawSignalDiagnosticSampler(recorder, {
      heartbeatMs: 1_000,
      positionJumpThresholdMs: 750,
    });
    recorder.start();
    expect(sampler.record(signal(0, {
      positionMs: 10_000,
      playbackState: 'paused',
      eventKind: 'pause',
    }))).toBe(true);
    // Paused expected position is frozen; tiny drift stays coalesced.
    expect(sampler.record(signal(300, {
      positionMs: 10_100,
      playbackState: 'paused',
      eventKind: 'pause',
    }))).toBe(false);
    // A paused-state seek records immediately.
    expect(sampler.record(signal(500, {
      positionMs: 55_000,
      playbackState: 'paused',
      eventKind: 'pause',
    }))).toBe(true);
  });
});
