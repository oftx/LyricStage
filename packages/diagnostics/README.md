# LyricStage Diagnostics

`@lyric-stage/diagnostics` owns development-only, bounded playback-signal
recording. It does not own source authority, projected playback time, platform
DOM access, storage, or renderer state.

## Guarantees

- Recording is disabled until an explicit `start` command.
- Repeated polling samples are coalesced to state changes plus a 1 Hz heartbeat.
- Raw source IDs and media identities are salted into recorder-local tokens
  before retention.
- Page text, URLs, lyric bodies, cookies, tokens, and request headers are not
  accepted by the fixture schema.
- Retention is bounded to 8,000 entries, 15 minutes, and approximately 4 MiB.
- Export remains compatible with `parseRecordedPlaybackFixture()` in
  `@lyric-stage/playback-core`.

## Extension development control

The Phase 0 Extension shell exposes a page-visible development control channel:

```text
kind: lyric-stage-extension-diagnostics-control
commands: start | stop | clear | summary | export
```

Responses use `lyric-stage-extension-diagnostics-response`. The channel is for
the unpacked development shell only. It returns redacted numeric fixtures, is
not a secret boundary, and must not be copied unchanged into a production
content script.
