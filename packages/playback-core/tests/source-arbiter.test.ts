import { describe, expect, it } from 'vitest';
import { SourceArbiter } from '../src/index.js';
import { signal } from './helpers.js';

describe('SourceArbiter', () => {
  it('keeps a healthy authority through a single failed read', () => {
    const arbiter = new SourceArbiter({ unhealthyGraceMs: 500 });
    expect(arbiter.observe(signal(), 0).authority?.sourceInstanceId).toBe('media-1');

    const result = arbiter.observe(signal({
      producerSequence: 2,
      playbackState: 'unavailable',
      eventKind: 'source-lost',
      confidence: 0,
    }), 100);
    expect(result.authority?.sourceInstanceId).toBe('media-1');
    expect(result.changed).toBe(false);
    expect(result.authorityHealthy).toBe(false);
  });

  it('requires two coherent samples before a higher-priority takeover', () => {
    const arbiter = new SourceArbiter({ switchCooldownMs: 0 });
    arbiter.observe(signal(), 0);
    const first = arbiter.observe(signal({
      producerSequence: 2,
      sourceInstanceId: 'api-1',
      sourceKind: 'platform-api',
      positionMs: 100,
      capturedAtMs: 100,
    }), 100);
    expect(first.authority?.sourceInstanceId).toBe('media-1');
    expect(first.signalIsAuthoritative).toBe(false);

    const second = arbiter.observe(signal({
      producerSequence: 3,
      sourceInstanceId: 'api-1',
      sourceKind: 'platform-api',
      positionMs: 200,
      capturedAtMs: 200,
    }), 200);
    expect(second.authority?.sourceInstanceId).toBe('api-1');
    expect(second.signalIsAuthoritative).toBe(true);
    expect(second.reason).toBe('higher-priority-source');
  });

  it('only lets a lower-priority fallback take over after grace', () => {
    const arbiter = new SourceArbiter({ unhealthyGraceMs: 500, switchCooldownMs: 0 });
    arbiter.observe(signal({ sourceKind: 'platform-api', sourceInstanceId: 'api-1' }), 0);
    arbiter.observe(signal({
      producerSequence: 2,
      sourceInstanceId: 'dom-1',
      sourceKind: 'dom-progress',
      positionMs: 100,
      capturedAtMs: 100,
    }), 100);
    arbiter.observe(signal({
      producerSequence: 3,
      sourceInstanceId: 'dom-1',
      sourceKind: 'dom-progress',
      positionMs: 200,
      capturedAtMs: 200,
    }), 200);
    arbiter.observe(signal({
      producerSequence: 4,
      sourceInstanceId: 'api-1',
      sourceKind: 'platform-api',
      playbackState: 'unavailable',
      eventKind: 'source-lost',
      confidence: 0,
      capturedAtMs: 250,
    }), 250);
    expect(arbiter.evaluate(749).authority?.sourceInstanceId).toBe('api-1');
    expect(arbiter.evaluate(750).authority?.sourceInstanceId).toBe('dom-1');
  });

  it('ignores stale producer sequences', () => {
    const arbiter = new SourceArbiter();
    arbiter.observe(signal({ producerSequence: 3 }), 0);
    const stale = arbiter.observe(signal({ producerSequence: 2 }), 100);
    expect(stale.accepted).toBe(false);
    expect(stale.authority?.sourceInstanceId).toBe('media-1');
  });

  it('does not bootstrap an authority from an unavailable source', () => {
    const arbiter = new SourceArbiter();
    const result = arbiter.observe(signal({
      playbackState: 'unavailable',
      eventKind: 'source-lost',
      confidence: 0,
    }), 0);
    expect(result.authority).toBeNull();
    expect(result.signalIsAuthoritative).toBe(false);
  });

  it('does not let repeated unavailable samples become a takeover candidate', () => {
    const arbiter = new SourceArbiter({ switchCooldownMs: 0 });
    arbiter.observe(signal(), 0);
    arbiter.observe(signal({
      producerSequence: 2,
      sourceInstanceId: 'api-1',
      sourceKind: 'platform-api',
      playbackState: 'unavailable',
      eventKind: 'source-lost',
      confidence: 0,
      capturedAtMs: 100,
    }), 100);
    const repeated = arbiter.observe(signal({
      producerSequence: 3,
      sourceInstanceId: 'api-1',
      sourceKind: 'platform-api',
      playbackState: 'unavailable',
      eventKind: 'source-lost',
      confidence: 0,
      capturedAtMs: 200,
    }), 200);
    expect(repeated.authority?.sourceInstanceId).toBe('media-1');
    expect(repeated.changed).toBe(false);
  });

  it('reports a reused authoritative source entering a new session candidate', () => {
    const arbiter = new SourceArbiter();
    arbiter.observe(signal(), 0);
    const result = arbiter.observe(signal({
      producerSequence: 2,
      sessionCandidateId: 'candidate-2',
      eventKind: 'media-candidate',
    }), 100);
    expect(result.changed).toBe(false);
    expect(result.sessionCandidateChanged).toBe(true);
  });

  it('does not ping-pong back to a lower-priority source while authority is healthy', () => {
    const arbiter = new SourceArbiter({ switchCooldownMs: 0 });
    arbiter.observe(signal(), 0);
    arbiter.observe(signal({
      producerSequence: 2,
      sourceInstanceId: 'api-1',
      sourceKind: 'platform-api',
      positionMs: 100,
      capturedAtMs: 100,
    }), 100);
    arbiter.observe(signal({
      producerSequence: 3,
      sourceInstanceId: 'api-1',
      sourceKind: 'platform-api',
      positionMs: 200,
      capturedAtMs: 200,
    }), 200);
    const lowerPriority = arbiter.observe(signal({
      producerSequence: 4,
      sourceInstanceId: 'media-1',
      sourceKind: 'media-element',
      positionMs: 300,
      capturedAtMs: 300,
    }), 300);
    expect(lowerPriority.authority?.sourceInstanceId).toBe('api-1');
    expect(lowerPriority.changed).toBe(false);
  });

  it('lets a confirmed different-media source replace authority without waiting for TTL', () => {
    const arbiter = new SourceArbiter({ switchCooldownMs: 0 });
    expect(arbiter.observe(signal({
      sourceInstanceId: 'song-a',
      sessionCandidateId: 'candidate-a',
      positionMs: 50_000,
    }), 0).authority?.sourceInstanceId).toBe('song-a');

    const first = arbiter.observe(signal({
      producerSequence: 2,
      sourceInstanceId: 'song-b',
      sessionCandidateId: 'candidate-b',
      positionMs: 0,
      capturedAtMs: 100,
      eventKind: 'media-candidate',
    }), 100);
    expect(first.changed).toBe(false);
    expect(first.signalIsAuthoritative).toBe(false);
    expect(first.authority?.sourceInstanceId).toBe('song-a');

    const second = arbiter.observe(signal({
      producerSequence: 3,
      sourceInstanceId: 'song-b',
      sessionCandidateId: 'candidate-b',
      positionMs: 250,
      capturedAtMs: 250,
      eventKind: 'sample',
    }), 250);
    expect(second.changed).toBe(true);
    expect(second.reason).toBe('media-replacement');
    expect(second.signalIsAuthoritative).toBe(true);
    expect(second.sessionCandidateChanged).toBe(true);
    expect(second.authority?.sourceInstanceId).toBe('song-b');
  });
});
