import type { LyricDocumentPayloadV1 } from '@lyric-stage/extension-protocol';

/** Same demo body as the surface shell; content is the publisher of truth. */
export const CONTENT_DEMO_LRC = `
[ti:LyricStage Demo]
[ar:Extension Shell]
[al:Phase 0]
[length:03:00.00]
[00:00.00]LyricStage extension shell
[00:04.00]Content owns the live clock
[00:08.00]This window projects sparse anchors
[00:12.00]Player-core renders the document
[00:16.00]Follow the timeline as it moves
[00:20.00]Pause freezes the projected line
[00:24.00]Seek jumps from content authority
[00:28.00]No platform DOM inside this surface
[00:32.00]Popup stays status-only by design
[00:36.00]Worker is the control plane only
[00:40.00]Replace this demo with real lyrics
[00:44.00]Keep credentials out of the bridge
[00:48.00]Keep fonts out of runtime messages
[00:52.00]Phase 0 product path continues
[00:56.00]Open a supported music tab to bind
[01:00.00]YouTube QQ Music NetEase first
[01:10.00]Sparse anchors keep the worker light
[01:20.00]Surface reconnection is one snapshot
[01:30.00]LyricStage demo track end approach
[01:40.00]Hold the final line while ended
[01:50.00]Thank you for testing the shell
[02:00.00]Demo complete
`.trim();

export function createDemoLyricDocumentPayload(
  mediaId: string,
  revision: number,
): LyricDocumentPayloadV1 {
  return {
    mediaId,
    format: 'lrc',
    text: CONTENT_DEMO_LRC,
    sourceName: 'content-demo',
    revision,
  };
}
