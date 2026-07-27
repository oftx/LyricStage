import { describe, expect, it } from 'vitest';
import {
  parseAppleRequest,
  parseAppleResponse,
  selectBestTtmlCandidate,
} from '../src/musickit/protocol.js';

describe('apple music request protocol', () => {
  it('accepts a bounded lyrics request envelope', () => {
    const parsed = parseAppleRequest({
      channel: 'lyric-stage-apple-music-request-v1',
      protocolVersion: 1,
      direction: 'isolated-to-main',
      bridgeInstanceId: 'bridge:test-1',
      nonce: '0123456789abcdef0123456789abcdef',
      sequence: 1,
      requestId: 'request:abc',
      command: {
        type: 'request-lyrics',
        catalogId: '1158763993',
        locale: 'zh-Hans-CN',
      },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.value.command).toEqual({
      type: 'request-lyrics',
      catalogId: '1158763993',
      locale: 'zh-Hans-CN',
    });
  });

  it('accepts library-style media ids for MAIN-side resolution', () => {
    const parsed = parseAppleRequest({
      channel: 'lyric-stage-apple-music-request-v1',
      protocolVersion: 1,
      direction: 'isolated-to-main',
      bridgeInstanceId: 'bridge:test-1',
      nonce: '0123456789abcdef0123456789abcdef',
      sequence: 3,
      requestId: 'request:lib',
      command: {
        type: 'request-lyrics',
        catalogId: 'i.abcLibrarySong',
        locale: 'en-US',
      },
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts catalogId current for nowPlaying resolution', () => {
    const parsed = parseAppleRequest({
      channel: 'lyric-stage-apple-music-request-v1',
      protocolVersion: 1,
      direction: 'isolated-to-main',
      bridgeInstanceId: 'bridge:test-1',
      nonce: '0123456789abcdef0123456789abcdef',
      sequence: 4,
      requestId: 'request:current',
      command: {
        type: 'request-lyrics',
        catalogId: 'current',
        locale: 'zh-Hans-CN',
      },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.value.command).toMatchObject({
      type: 'request-lyrics',
      catalogId: 'current',
    });
  });

  it('rejects arbitrary command fields', () => {
    const parsed = parseAppleRequest({
      channel: 'lyric-stage-apple-music-request-v1',
      protocolVersion: 1,
      direction: 'isolated-to-main',
      bridgeInstanceId: 'bridge:test-1',
      nonce: '0123456789abcdef0123456789abcdef',
      sequence: 1,
      requestId: 'request:abc',
      command: {
        type: 'request-lyrics',
        catalogId: '1158763993',
        locale: 'zh-Hans-CN',
        url: 'https://evil.example/',
      },
    });
    expect(parsed.success).toBe(false);
  });

  it('parses a lyrics response and selects preferred locale', () => {
    const ttml = '<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml"></tt>';
    const parsed = parseAppleResponse({
      channel: 'lyric-stage-apple-music-request-v1',
      protocolVersion: 1,
      direction: 'main-to-isolated',
      bridgeInstanceId: 'bridge:test-1',
      nonce: '0123456789abcdef0123456789abcdef',
      sequence: 2,
      requestId: 'request:abc',
      result: {
        type: 'lyrics',
        catalogId: '1158763993',
        storefront: 'cn',
        locale: 'zh-Hans-CN',
        status: 200,
        candidates: [
          { locale: 'en-US', ttml: `${ttml}<!--en-->` },
          { locale: 'zh-Hans-CN', ttml: `${ttml}<!--zh-->` },
        ],
      },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success || parsed.value.result.type !== 'lyrics') return;
    const best = selectBestTtmlCandidate(parsed.value.result.candidates, 'zh-Hans-CN');
    expect(best?.locale).toBe('zh-Hans-CN');
    expect(best?.ttml).toContain('<!--zh-->');
  });
});
