import { describe, expect, it } from 'vitest';
import { isLyricDocumentPayloadV1 } from '@lyric-stage/extension-protocol';

describe('TTML lyric-document protocol', () => {
  it('accepts ttml as a primary lyric format for Apple Music', () => {
    expect(isLyricDocumentPayloadV1({
      mediaId: 'applemusic:1158763993',
      format: 'ttml',
      text: '<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml"></tt>',
      sourceName: 'applemusic:1158763993',
      revision: 1,
    })).toBe(true);
  });
});
