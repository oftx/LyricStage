import { describe, expect, it } from 'vitest';
import {
  createMessageEnvelopeV1,
  isSparsePlaybackAnchorV1,
  parseMessageEnvelopeV1,
  parsePlaybackPayload,
  parseSessionPayload,
} from '../src/index.js';

describe('message envelope v1', () => {
  it('accepts a minimal valid envelope', () => {
    const envelope = createMessageEnvelopeV1({
      channel: 'playback',
      type: 'sparse-anchor',
      messageId: 'msg-1',
      sentAtMs: 1,
      payload: { kind: 'session-snapshot', anchor: null },
    });
    expect(parseMessageEnvelopeV1(envelope)).toEqual({ ok: true, value: envelope });
  });

  it('rejects unknown own keys and prototype pollution', () => {
    expect(parseMessageEnvelopeV1({
      protocolVersion: 1,
      channel: 'playback',
      type: 'x',
      messageId: 'm',
      sentAtMs: 1,
      payload: null,
      unexpected: true,
    })).toEqual({ ok: false, code: 'invalid-envelope' });

    expect(parseMessageEnvelopeV1(Object.assign(
      Object.create({ protocolVersion: 1 }) as Record<string, unknown>,
      {
        channel: 'playback',
        type: 'x',
        messageId: 'm',
        sentAtMs: 1,
        payload: null,
      },
    ))).toEqual({ ok: false, code: 'invalid-envelope' });
  });
});

describe('playback payloads', () => {
  const anchor = {
    protocolVersion: 1 as const,
    sessionId: 'session:1',
    generation: 1,
    mediaId: 'media:a',
    positionMs: 12,
    rate: 1,
    state: 'playing' as const,
    producedAtMs: 100,
    sequence: 2,
  };

  it('validates sparse anchors strictly', () => {
    expect(isSparsePlaybackAnchorV1(anchor)).toBe(true);
    expect(isSparsePlaybackAnchorV1({ ...anchor, sequence: 0 })).toBe(false);
    expect(parsePlaybackPayload({ kind: 'sparse-anchor', anchor })).toEqual({
      kind: 'sparse-anchor',
      anchor,
    });
    expect(parsePlaybackPayload({ kind: 'seek-intent', surfaceId: 's', targetMs: -1 })).toBeNull();
  });

  it('accepts media-meta with optional title/creators and rejects invalid shapes', async () => {
    const { isMediaMetaPayloadV1, parsePlaybackPayload: parse } = await import('../src/index.js');
    const base = { mediaId: 'bilibili:BV1', coverUrl: null };
    expect(isMediaMetaPayloadV1(base)).toBe(true);
    expect(isMediaMetaPayloadV1({ ...base, title: 'Song', creators: ['Up'] })).toBe(true);
    expect(isMediaMetaPayloadV1({ ...base, title: '' })).toBe(false);
    expect(isMediaMetaPayloadV1({ ...base, creators: ['ok', ''] })).toBe(false);
    expect(isMediaMetaPayloadV1({ ...base, creators: 'solo' })).toBe(false);
    const parsed = parse({
      kind: 'media-meta',
      meta: { ...base, title: 'Song', creators: ['Up'] },
    });
    expect(parsed).toEqual({
      kind: 'media-meta',
      meta: { mediaId: 'bilibili:BV1', coverUrl: null, title: 'Song', creators: ['Up'] },
    });
  });

  it('accepts optional durationMs and rejects invalid values and unknown keys', () => {
    expect(isSparsePlaybackAnchorV1({ ...anchor, durationMs: 180_000 })).toBe(true);
    expect(isSparsePlaybackAnchorV1({ ...anchor, durationMs: null })).toBe(true);
    expect(isSparsePlaybackAnchorV1({ ...anchor, durationMs: 0 })).toBe(false);
    expect(isSparsePlaybackAnchorV1({ ...anchor, durationMs: Number.NaN })).toBe(false);
    expect(isSparsePlaybackAnchorV1({ ...anchor, durationMs: 'long' })).toBe(false);
    expect(isSparsePlaybackAnchorV1({ ...anchor, unexpected: 1 })).toBe(false);
    const { sequence: _dropped, ...missingSequence } = anchor;
    expect(isSparsePlaybackAnchorV1(missingSequence)).toBe(false);
  });

  it('parses lyric-clear and rejects invalid media ids', async () => {
    const { parsePlaybackPayload: parse } = await import('../src/index.js');
    expect(parse({ kind: 'lyric-clear', mediaId: 'netease:123' }))
      .toEqual({ kind: 'lyric-clear', mediaId: 'netease:123' });
    expect(parse({ kind: 'lyric-clear', mediaId: '' })).toBeNull();
    expect(parse({ kind: 'lyric-clear', mediaId: 42 })).toBeNull();
    expect(parse({ kind: 'lyric-clear', mediaId: 'x'.repeat(513) })).toBeNull();
  });

  it('parses lyric-document and session-snapshot with lyrics', () => {
    const document = {
      mediaId: 'media:a',
      format: 'lrc' as const,
      text: '[00:00.00]hello',
      sourceName: 'demo',
      revision: 1,
    };
    expect(parsePlaybackPayload({ kind: 'lyric-document', document })).toEqual({
      kind: 'lyric-document',
      document,
    });
    expect(parsePlaybackPayload({
      kind: 'session-snapshot',
      anchor,
      lyricDocument: document,
    })).toEqual({
      kind: 'session-snapshot',
      anchor,
      lyricDocument: document,
    });
    expect(parsePlaybackPayload({
      kind: 'lyric-document',
      document: { ...document, text: '' },
    })).toBeNull();
  });

  it('parses lyric-document with translation and pronunciation tracks', () => {
    const document = {
      mediaId: 'netease:1',
      format: 'lrc' as const,
      text: '[00:01.00]original',
      sourceName: 'netease.lrc',
      revision: 2,
      translationText: '[00:01.00]翻译',
      pronunciationText: '[00:01.00]hatsuon',
    };
    const parsed = parsePlaybackPayload({ kind: 'lyric-document', document });
    expect(parsed).toMatchObject({
      kind: 'lyric-document',
      document: {
        mediaId: 'netease:1',
        translationText: '[00:01.00]翻译',
        pronunciationText: '[00:01.00]hatsuon',
      },
    });
  });
});

describe('session payloads', () => {
  it('parses source hello/goodbye', () => {
    expect(parseSessionPayload({
      kind: 'source-hello',
      sessionId: 'session:1',
      generation: 1,
      mediaId: 'media:a',
    })).toMatchObject({ kind: 'source-hello' });
    expect(parseSessionPayload({ kind: 'select-source', tabId: 3 })).toEqual({
      kind: 'select-source',
      tabId: 3,
    });
  });

  it('parses select-source by sessionId and source-list', () => {
    expect(parseSessionPayload({
      kind: 'select-source',
      sessionId: 'session:qq',
    })).toEqual({
      kind: 'select-source',
      sessionId: 'session:qq',
    });
    expect(parseSessionPayload({ kind: 'request-source-list' })).toEqual({
      kind: 'request-source-list',
    });
    const list = parseSessionPayload({
      kind: 'source-list',
      selectedSessionId: 'session:1',
      sources: [{
        sessionId: 'session:1',
        generation: 1,
        mediaId: 'netease:1',
        tabId: 12,
        state: 'playing',
        positionMs: 1000,
        selected: true,
        platformLabel: 'NetEase',
      }],
    });
    expect(list).toMatchObject({
      kind: 'source-list',
      selectedSessionId: 'session:1',
    });
    expect(list && list.kind === 'source-list' && list.sources).toHaveLength(1);
  });
});
