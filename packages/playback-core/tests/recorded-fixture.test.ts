import { describe, expect, it } from 'vitest';
import {
  parseRecordedPlaybackFixture,
  replayPlaybackFixture,
} from '../src/index.js';

function recordedFixture(signals: readonly Record<string, unknown>[]): unknown {
  return {
    schema: 'lyric-stage-raw-playback-signals',
    schemaVersion: 1,
    platformId: 'youtube',
    producerInstanceId: 'producer-test',
    captureStartedAt: '2026-07-22T00:00:00.000Z',
    exportedAt: '2026-07-22T00:01:00.000Z',
    recording: false,
    droppedEntries: 0,
    approximateBytes: 1_000,
    limits: { maxEntries: 8_000, maxDurationMs: 900_000, maxBytes: 4_194_304 },
    signals,
  };
}

function recordedSignal(
  sequence: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    sequence,
    elapsedMs: (sequence - 1) * 1_000,
    positionMs: (sequence - 1) * 1_000,
    durationMs: 180_000,
    playbackState: 'playing',
    rate: 1,
    seeking: false,
    sourceKind: 'media-element',
    confidence: 1,
    eventKind: 'sample',
    sourceInstanceId: 'source-token-1',
    mediaInstanceId: 'media-token-1',
    sourceEvent: 'timeupdate',
    ...overrides,
  };
}

describe('recorded fixture compatibility importer', () => {
  it('converts recorder v1 entries into strict replay signals', () => {
    const result = parseRecordedPlaybackFixture(recordedFixture([
      recordedSignal(1),
      recordedSignal(2),
    ]));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value).toMatchObject({
      platformId: 'youtube',
      producerInstanceId: 'producer-test',
      sourceInstanceCount: 1,
      mediaInstanceCount: 1,
    });
    expect(result.value.fixture.entries[0]?.signal).toMatchObject({
      producerSequence: 1,
      sessionCandidateId: 'recorded:youtube:media-token-1',
      sourceInstanceId: 'source-token-1',
      mediaIdentity: { platform: 'youtube', externalId: 'media-token-1' },
    });
  });

  it('maps recorder-only unknown/other values without accepting malformed data', () => {
    const result = parseRecordedPlaybackFixture(recordedFixture([
      recordedSignal(1, {
        sourceKind: 'unknown',
        playbackState: 'unavailable',
        eventKind: 'other',
        sourceInstanceId: null,
        mediaInstanceId: null,
        positionMs: null,
        confidence: 0,
      }),
    ]));
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.value.fixture.entries[0]?.signal).toMatchObject({
      sourceKind: 'page-state',
      sourceInstanceId: 'recorder-source:page-state',
      eventKind: 'source-lost',
      mediaIdentity: null,
    });

    const invalid = parseRecordedPlaybackFixture(recordedFixture([
      recordedSignal(1, { confidence: 5 }),
    ]));
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(invalid.issues.map((issue) => issue.path)).toContain('$.signals[0].confidence');
    }
  });

  it('rejects reordered entries instead of silently repairing the fixture', () => {
    const result = parseRecordedPlaybackFixture(recordedFixture([
      recordedSignal(2, { elapsedMs: 1_000 }),
      recordedSignal(1, { elapsedMs: 500 }),
    ]));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues.map((issue) => issue.path)).toEqual(expect.arrayContaining([
        '$.signals[1].sequence',
        '$.signals[1].elapsedMs',
      ]));
    }
  });

  it('turns tokenized media changes into session candidate changes for replay', () => {
    const imported = parseRecordedPlaybackFixture(recordedFixture([
      recordedSignal(1, { positionMs: 50_000 }),
      recordedSignal(2, {
        mediaInstanceId: 'media-token-2',
        positionMs: 0,
        eventKind: 'media-candidate',
      }),
    ]));
    expect(imported.success).toBe(true);
    if (!imported.success) return;
    const replay = replayPlaybackFixture(imported.value.fixture);
    expect(replay.frames[1]?.timelineResult?.reason).toBe('session-started');
    expect(replay.frames[1]?.snapshot?.positionMs).toBe(0);
    expect(replay.frames[1]?.snapshot?.sessionId).toBe(
      'recorded-session:producer-test:1',
    );
  });

  it('replays buffering and seek events without false reverse steps', () => {
    const imported = parseRecordedPlaybackFixture(recordedFixture([
      recordedSignal(1),
      recordedSignal(2, {
        positionMs: 1_000,
        playbackState: 'buffering',
        eventKind: 'buffer-start',
      }),
      recordedSignal(3, {
        positionMs: 20_000,
        eventKind: 'seek-end',
      }),
    ]));
    expect(imported.success).toBe(true);
    if (!imported.success) return;
    const replay = replayPlaybackFixture(imported.value.fixture);
    expect(replay.falseBackwardSteps).toBe(0);
    expect(replay.discontinuityCount).toBe(1);
  });
});
