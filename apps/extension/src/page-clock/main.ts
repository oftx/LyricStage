export interface PageClockMainBridgeOptions {
  readonly bridgeInstanceId?: string;
  readonly nonce?: string;
  /**
   * Open mode (default): accept any same-origin isolated client on this
   * channel. Used by the MAIN content-script bridge so progress works even
   * when the service worker is asleep and cannot executeScript.
   */
  readonly open?: boolean;
}

const OPEN_BRIDGE_MARKER = '__lyricStagePageClockBridgeInstalled';

/**
 * Self-contained MAIN-world page clock + seek bridge.
 * Prefer loading as a document_start MAIN content script (open mode).
 * Optional pin mode still supports worker executeScript inject.
 *
 * Tracks page-owned HTMLMediaElement instances (including unattached Audio())
 * and optional platform player identity hints.
 */
export function installPageClockMainBridge(
  options: PageClockMainBridgeOptions = {},
): void {
  const openMode = options.open !== false
    && !options.bridgeInstanceId
    && !options.nonce;
  if (openMode) {
    if ((window as unknown as Record<string, boolean>)[OPEN_BRIDGE_MARKER]) {
      return;
    }
    (window as unknown as Record<string, boolean>)[OPEN_BRIDGE_MARKER] = true;
  }

  const channel = 'lyric-stage-page-clock-v1';
  const protocolVersion = 1;
  const maximumRememberedRequests = 256;
  const maximumTrackedClients = 32;
  const seenRequestIds = new Set<string>();
  const requestOrder: string[] = [];
  /**
   * Sequence ordering is per client (bridgeInstanceId + nonce), never global:
   * a reloaded extension starts a fresh client at sequence 1, and a global
   * high-water mark from the previous client would silently drop everything
   * it sends (P0-1). Bounded LRU so a hostile page cannot grow this map.
   */
  const lastSequenceByClient = new Map<string, number>();
  let disposed = false;
  const pinnedBridgeId = options.bridgeInstanceId ?? null;
  const pinnedNonce = options.nonce ?? null;

  type MediaStore = {
    readonly version: 1;
    remember(media: HTMLMediaElement | null | undefined): void;
    getAliveMedia(): HTMLMediaElement[];
    probeKnownRoots(): void;
  };
  const storeKey = '__lyricStagePageClockMedia';
  const shared = (window as unknown as Record<string, MediaStore | undefined>)[storeKey];

  // Local fallback if early-hooks did not run (e.g. dynamic inject only).
  const mediaList: HTMLMediaElement[] = [];
  const mediaSet = new WeakSet<HTMLMediaElement>();

  function rememberLocal(media: HTMLMediaElement | null | undefined): void {
    if (!media || mediaSet.has(media)) return;
    try {
      void media.paused;
    } catch {
      return;
    }
    mediaSet.add(media);
    mediaList.push(media);
  }

  function remember(media: HTMLMediaElement | null | undefined): void {
    if (shared) {
      shared.remember(media);
      return;
    }
    rememberLocal(media);
  }

  function pruneMedia(): HTMLMediaElement[] {
    if (shared) return shared.getAliveMedia();
    const alive: HTMLMediaElement[] = [];
    for (const media of mediaList) {
      try {
        const hasSource = Boolean(media.currentSrc || media.src);
        if (hasSource || media.isConnected) alive.push(media);
      } catch {
        // drop
      }
    }
    mediaList.length = 0;
    for (const media of alive) mediaList.push(media);
    return alive;
  }

  function findMediaInObject(root: unknown): void {
    if (!root || typeof root !== 'object') return;
    const seen = new Set<object>();
    const queue: unknown[] = [root];
    let steps = 0;
    while (queue.length > 0 && steps < 280) {
      steps += 1;
      const current = queue.shift();
      if (!current || typeof current !== 'object') continue;
      if (current instanceof HTMLMediaElement) {
        remember(current);
        continue;
      }
      if (current instanceof Node) continue;
      if (seen.has(current)) continue;
      seen.add(current);
      let keys: string[] = [];
      try {
        keys = Object.keys(current).slice(0, 56);
      } catch {
        continue;
      }
      for (const key of keys) {
        try {
          queue.push((current as Record<string, unknown>)[key]);
        } catch {
          // ignore
        }
      }
    }
  }

  function probeKnownRoots(): void {
    if (shared) {
      shared.probeKnownRoots();
      return;
    }
    const candidates = [
      (window as unknown as { player?: unknown }).player,
      (window as unknown as { Player?: unknown }).Player,
      (window as unknown as { MUSIC?: unknown }).MUSIC,
      (window as unknown as { qqmusic?: unknown }).qqmusic,
      (window as unknown as { M?: unknown }).M,
      (window as unknown as { nm?: unknown }).nm,
      (window as unknown as { NEJ?: unknown }).NEJ,
    ];
    for (const candidate of candidates) findMediaInObject(candidate);
    try {
      document.querySelectorAll('audio, video').forEach((node) => {
        remember(node as HTMLMediaElement);
      });
    } catch {
      // ignore
    }
  }

  // If early hooks are missing, install minimal late hooks so we still recover.
  if (!shared) {
    try {
      const NativeAudio = window.Audio;
      function PatchedAudio(
        this: unknown,
        ...args: ConstructorParameters<typeof Audio>
      ): HTMLAudioElement {
        const audio = Reflect.construct(
          NativeAudio,
          args,
          new.target || PatchedAudio,
        ) as HTMLAudioElement;
        rememberLocal(audio);
        return audio;
      }
      PatchedAudio.prototype = NativeAudio.prototype;
      Object.setPrototypeOf(PatchedAudio, NativeAudio);
      (window as unknown as { Audio: typeof Audio }).Audio =
        PatchedAudio as unknown as typeof Audio;
    } catch {
      // ignore
    }
    try {
      const proto = HTMLMediaElement.prototype;
      const nativePlay = proto.play;
      proto.play = function patchedPlay(
        this: HTMLMediaElement,
        ...args: Parameters<typeof nativePlay>
      ): ReturnType<typeof nativePlay> {
        rememberLocal(this);
        const promise = nativePlay.apply(this, args);
        // Suppress unhandled AbortError/NotAllowedError noise in the console.
        if (promise !== undefined && typeof promise.catch === 'function') {
          promise.catch((err: Error) => {
            if (err && (err.name === 'AbortError' || err.name === 'NotAllowedError')) {
              // Ignore
            }
          });
        }
        return promise;
      };
    } catch {
      // ignore
    }
    for (const type of ['play', 'playing', 'timeupdate', 'seeked'] as const) {
      window.addEventListener(type, (event) => {
        const target = event.target;
        if (target instanceof HTMLMediaElement) rememberLocal(target);
      }, true);
    }
  }

  function readNeteasePlayingState(): {
    readonly trackId: string | null;
    readonly playing: boolean | null;
    readonly durationMs: number | null;
  } {
    try {
      const player = (window as unknown as {
        player?: {
          getPlaying?: () => {
            track?: {
              id?: number | string;
              duration?: number;
              dt?: number;
            } | null;
            playing?: boolean;
          } | null;
        };
      }).player;
      const state = player?.getPlaying?.call(player);
      if (!state) {
        return { trackId: null, playing: null, durationMs: null };
      }
      const id = state.track?.id;
      const trackId = id === undefined || id === null
        ? null
        : (/^\d{1,18}$/.test(String(id)) ? String(id) : null);
      const durationRaw = Number(state.track?.duration ?? state.track?.dt ?? 0);
      const durationMs = Number.isFinite(durationRaw) && durationRaw > 0
        ? (durationRaw > 10_000 ? durationRaw : durationRaw * 1000)
        : null;
      return {
        trackId,
        playing: typeof state.playing === 'boolean' ? state.playing : null,
        durationMs,
      };
    } catch {
      return { trackId: null, playing: null, durationMs: null };
    }
  }

  function readNeteaseIdentity(): string | null {
    return readNeteasePlayingState().trackId;
  }

  function isAppleMusicHost(): boolean {
    try {
      const host = window.location.hostname.replace(/^www\./, '');
      return host === 'music.apple.com' || host.endsWith('.music.apple.com');
    } catch {
      return false;
    }
  }

  function extractAppleMusicCatalogId(value: string | null | undefined): string | null {
    if (!value) return null;
    try {
      const url = new URL(value, 'https://music.apple.com');
      const fromQuery = url.searchParams.get('i');
      if (fromQuery && /^\d{1,20}$/.test(fromQuery)) return fromQuery;
      const songMatch = url.pathname.match(/\/song\/(?:[^/]+\/)?(\d{1,20})(?:\/|$)/i);
      if (songMatch?.[1]) return songMatch[1];
    } catch {
      // fall through
    }
    const match = value.match(/[?&]i=(\d{1,20})(?:[&#]|$)/)
      ?? value.match(/\/song\/(?:[^/]+\/)?(\d{1,20})(?:\/|[?#]|$)/i);
    return match?.[1] ?? null;
  }

  function readMusicKitInstance(): Record<string, unknown> | null {
    try {
      const musicKit = (window as Window & {
        MusicKit?: {
          getInstance?: () => unknown;
          Instance?: unknown;
        };
      }).MusicKit;
      if (!musicKit) return null;
      let raw: unknown = null;
      try {
        raw = musicKit.getInstance?.();
      } catch {
        raw = null;
      }
      if (!raw && musicKit.Instance) raw = musicKit.Instance;
      return raw && typeof raw === 'object'
        ? raw as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }

  /**
   * Match lyric-stage userscript getAppleMusicCatalogId:
   * playParams.catalogId → playParams.id → item.id (no digit scraping).
   */
  function asMediaId(value: unknown): string {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
      return String(value);
    }
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    return /^[a-zA-Z0-9._-]{1,64}$/.test(trimmed) ? trimmed : '';
  }

  function readNowPlayingItem(
    instance: Record<string, unknown> | null,
  ): Record<string, unknown> | null {
    if (!instance) return null;
    if (isRecord(instance.nowPlayingItem)) return instance.nowPlayingItem;
    const player = isRecord(instance.player) ? instance.player : null;
    if (player && isRecord(player.nowPlayingItem)) return player.nowPlayingItem;
    const queue = isRecord(instance.queue) ? instance.queue : null;
    const current = queue && isRecord(queue.currentQueueItem)
      ? queue.currentQueueItem
      : null;
    if (current && isRecord(current.item)) return current.item;
    return null;
  }

  function readCatalogIdFromMediaItem(
    item: Record<string, unknown> | null,
  ): string | null {
    if (!item) return null;
    const attrs = isRecord(item.attributes) ? item.attributes : null;
    const playParams = attrs && isRecord(attrs.playParams)
      ? attrs.playParams
      : (isRecord(item.playParams) ? item.playParams : null);
    // Prefer numeric catalog id only. playParams.id / item.id are often
    // library ids (i.xxxx) that flap against catalogId after track changes.
    const catalog = asMediaId(playParams?.catalogId);
    if (catalog && /^\d{1,20}$/.test(catalog)) return catalog;
    const playId = asMediaId(playParams?.id);
    if (playId && /^\d{1,20}$/.test(playId)) return playId;
    const itemId = asMediaId(item.id);
    if (itemId && /^\d{1,20}$/.test(itemId)) return itemId;
    // Library-only: return library id (stable for this item, not mixed with catalog).
    return playId || itemId || null;
  }

  /** Sticky nowPlaying catalog so library↔catalog flaps cannot thrash mediaKey. */
  let amStickyCatalogId: string | null = null;
  let amStickyItemKey: string | null = null;

  function readDurationMsFromItem(item: Record<string, unknown> | null): number | null {
    if (!item) return null;
    const attrs = isRecord(item.attributes) ? item.attributes : null;
    const ms = Number(attrs?.durationInMillis);
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }

  function readAppleMusicCatalogIdFromDom(): string | null {
    // Only the now-playing LCD — never browse-page song lists.
    const selectors = [
      'amp-lcd a[href*="/song/"]',
      '[data-testid="lcd-song-link"]',
      '[data-testid="player-title"] a[href*="/song/"]',
      '.web-chrome-playback-lcd__song-name-scroll a[href*="/song/"]',
      '.web-chrome-playback-lcd a[href*="/song/"]',
      'div[class*="playback-lcd"] a[href*="/song/"]',
    ];
    for (const sel of selectors) {
      try {
        const link = document.querySelector(sel);
        if (!link) continue;
        const id = extractAppleMusicCatalogId(link.getAttribute('href'));
        if (id) return id;
      } catch {
        // ignore
      }
    }
    return extractAppleMusicCatalogId(window.location.href);
  }

  function readAppleMusicIdentityStore(): {
    discover(): string | null;
    getCatalogId(): string | null;
  } | null {
    try {
      const store = (window as unknown as {
        __lyricStageAppleMusicIdentity?: {
          version?: number;
          discover?: () => string | null;
          getCatalogId?: () => string | null;
        };
      }).__lyricStageAppleMusicIdentity;
      if (store?.version === 1 && typeof store.discover === 'function') {
        return {
          discover: () => store.discover?.() ?? null,
          getCatalogId: () => store.getCatalogId?.() ?? null,
        };
      }
    } catch {
      // ignore
    }
    return null;
  }

  function readAppleMusicCatalogId(): string | null {
    // 1) Live nowPlaying only (userscript parity) — never browse/network noise.
    const instance = readMusicKitInstance();
    const item = readNowPlayingItem(instance);
    const itemKey = item
      ? (asMediaId(item.id) || readCatalogIdFromMediaItem(item) || null)
      : null;
    const fromItem = readCatalogIdFromMediaItem(item);

    if (itemKey && itemKey !== amStickyItemKey) {
      // Real track change: drop previous sticky catalog.
      amStickyItemKey = itemKey;
      amStickyCatalogId = fromItem && /^\d{1,20}$/.test(fromItem) ? fromItem : null;
    } else if (fromItem && /^\d{1,20}$/.test(fromItem)) {
      amStickyCatalogId = fromItem;
    }

    if (amStickyCatalogId) return amStickyCatalogId;
    if (fromItem) return fromItem;

    // 2) Identity store (also nowPlaying-first after fix).
    const store = readAppleMusicIdentityStore();
    const discovered = store?.discover?.() ?? null;
    if (discovered && /^\d{1,20}$/.test(discovered)) {
      amStickyCatalogId = discovered;
      return discovered;
    }

    // 3) LCD / URL only when MusicKit has no item yet.
    return readAppleMusicCatalogIdFromDom();
  }

  // Free-run clock state — full lyric-stage AppleMusicPlaybackAdapter parity.
  // MusicKit currentPlaybackTime is sparse and often lies (0) after blur/focus.
  let amClockInit = false;
  let amLastSeconds = 0;
  let amLastAtMs = 0;
  let amPlaying = false;
  let amLastRawSeconds = Number.NaN;
  let amLastRawAtMs = 0;
  let amLastSnapshotSeconds = 0;
  let amMediaKey: string | null = null;
  let amPendingBackward: {
    sampleSeconds: number;
    observedAt: number;
    confirmations: number;
  } | null = null;
  let amConsecutivePauseSamples = 0;
  let amRawAdvanceStreak = 0;
  let amRawFrozenStreak = 0;
  let amPrevRawForAdvance = Number.NaN;
  const AM_SAMPLE_EPS_S = 0.005;
  const AM_FORWARD_DEADBAND_S = 0.1;
  const AM_FORWARD_CORRECTION_RATE = 0.05;
  /**
   * Free-run often ends ~0.3–1.2s ahead of MusicKit after track changes
   * (gap free-run + sticky playing). Pull back gently so lyrics don't stay
   * permanently early; seek force-reset already fixed that path.
   */
  const AM_LEAD_PULLBACK_DEADBAND_S = 0.12;
  const AM_LEAD_SOFT_SNAP_S = 0.45;
  const AM_LEAD_SOFT_SNAP_CONFIRMATIONS = 2;
  const AM_FORWARD_SEEK_S = 1.5;
  const AM_BACKWARD_SEEK_S = 1.5;
  const AM_RAW_SEEK_S = 0.75;
  const AM_BACKWARD_CONFIRM_TOL_S = 0.75;
  const AM_BACKWARD_CONFIRMATIONS = 2;
  /** Pause only after many consistent non-advancing samples while focused. */
  const AM_PAUSE_CONFIRMATIONS = 5;
  /** After track change, accept near-zero MusicKit times for this long. */
  const AM_TRACK_CHANGE_GRACE_MS = 2_500;
  let amTrackChangeAtMs = 0;
  let amLeadSnapConfirmations = 0;

  function amNowMs(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }

  function amDocumentHidden(): boolean {
    try {
      return document.visibilityState === 'hidden';
    } catch {
      return false;
    }
  }

  /**
   * Clicking outside the browser window blurs the page but does NOT set
   * document.hidden. MusicKit often flips isPlaying=false on blur while audio
   * continues — Apple's own lyrics ignore that and keep using the media clock.
   */
  function amPageUnfocused(): boolean {
    try {
      if (amDocumentHidden()) return true;
      if (typeof document.hasFocus === 'function' && !document.hasFocus()) {
        return true;
      }
    } catch {
      // ignore
    }
    return false;
  }

  function amHardInvalidateClock(): void {
    amClockInit = false;
    amPlaying = false;
    amLastSeconds = 0;
    amLastAtMs = 0;
    amLastRawSeconds = Number.NaN;
    amLastRawAtMs = 0;
    amLastSnapshotSeconds = 0;
    amPendingBackward = null;
    amConsecutivePauseSamples = 0;
    amRawAdvanceStreak = 0;
    amRawFrozenStreak = 0;
    amPrevRawForAdvance = Number.NaN;
    amLeadSnapConfirmations = 0;
    amTrackChangeAtMs = amNowMs();
  }

  function amInTrackChangeGrace(now = amNowMs()): boolean {
    return amTrackChangeAtMs > 0
      && now - amTrackChangeAtMs < AM_TRACK_CHANGE_GRACE_MS;
  }

  function amResetClock(seconds: number, playing: boolean): void {
    const now = amNowMs();
    // Never fall back to the previous track's free-run estimate after invalidate.
    const fallback = amClockInit ? amEstimateSeconds(now) : 0;
    const next = Number.isFinite(seconds) ? Math.max(0, seconds) : fallback;
    amLastSeconds = next;
    amLastAtMs = now;
    amPlaying = Boolean(playing);
    amClockInit = true;
    amLastRawSeconds = next;
    amLastRawAtMs = now;
    amLastSnapshotSeconds = next;
    amPendingBackward = null;
    amLeadSnapConfirmations = 0;
    amConsecutivePauseSamples = playing ? 0 : amConsecutivePauseSamples;
  }

  function amEstimateSeconds(now = amNowMs()): number {
    if (!amClockInit) return 0;
    return amLastSeconds + (amPlaying ? Math.max(0, now - amLastAtMs) / 1000 : 0);
  }

  /**
   * Observe a MusicKit time sample. Reverse seeks require confirmation so a
   * post-focus currentPlaybackTime=0 cannot wipe a healthy free-run clock.
   */
  function amObserveSample(rawSeconds: number, playing: boolean, force = false): void {
    const now = amNowMs();
    if (!amClockInit) {
      if (Number.isFinite(rawSeconds)) amResetClock(rawSeconds, playing);
      return;
    }
    if (!Number.isFinite(rawSeconds)) {
      if (playing !== amPlaying) {
        amResetClock(amEstimateSeconds(now), playing);
      }
      return;
    }

    const sample = Math.max(0, rawSeconds);
    const estimated = amEstimateSeconds(now);
    const trackChangeGrace = amInTrackChangeGrace(now);

    // After blur/focus MusicKit often reports 0 while audio is mid-track.
    // Never hard-snap a healthy free-run clock to near-zero without force —
    // except right after a track change, when near-zero is the real start.
    if (
      !force
      && !trackChangeGrace
      && sample < 0.35
      && estimated > 2
      && (playing || amPlaying)
    ) {
      return;
    }

    if (force || playing !== amPlaying) {
      // Never accept a pause while the page is unfocused/hidden — blur lies.
      // Require many consecutive pause samples only when the page is focused.
      if (!playing && amPlaying && !force) {
        if (amPageUnfocused()) {
          return;
        }
        amConsecutivePauseSamples += 1;
        if (amConsecutivePauseSamples < AM_PAUSE_CONFIRMATIONS) {
          return;
        }
      } else {
        amConsecutivePauseSamples = 0;
      }
      amResetClock(sample, playing);
      return;
    }

    amConsecutivePauseSamples = 0;

    if (
      Number.isFinite(amLastRawSeconds)
      && Math.abs(sample - amLastRawSeconds) < AM_SAMPLE_EPS_S
    ) {
      return;
    }

    if (!playing) {
      amResetClock(sample, false);
      return;
    }

    const previousSample = amLastRawSeconds;
    const previousSampleAt = amLastRawAtMs;
    const sampleElapsedSeconds = Number.isFinite(previousSample)
      ? Math.max(0, now - previousSampleAt) / 1000
      : 0;
    const expectedRawSeconds = Number.isFinite(previousSample)
      ? previousSample + sampleElapsedSeconds
      : sample;
    const phaseDelta = sample - estimated;
    const rawDiscontinuity = sample - expectedRawSeconds;
    amLastRawSeconds = sample;
    amLastRawAtMs = now;

    // Forward seek: require both free-run phase jump and raw discontinuity.
    if (
      phaseDelta >= AM_FORWARD_SEEK_S
      && rawDiscontinuity >= AM_RAW_SEEK_S
    ) {
      amResetClock(sample, true);
      return;
    }

    // After track change, accept the first real MusicKit sample immediately
    // even if free-run still carries a residual lead from the previous item.
    if (trackChangeGrace && Number.isFinite(sample) && Math.abs(phaseDelta) > 0.2) {
      amResetClock(sample, true);
      return;
    }

    const backwardSeekCandidate = phaseDelta <= -AM_BACKWARD_SEEK_S
      && rawDiscontinuity <= -AM_RAW_SEEK_S;

    if (!backwardSeekCandidate && !amPendingBackward) {
      if (phaseDelta > AM_FORWARD_DEADBAND_S) {
        amLeadSnapConfirmations = 0;
        const maxCorrection = sampleElapsedSeconds * AM_FORWARD_CORRECTION_RATE;
        const correction = Math.min(phaseDelta, Math.max(0, maxCorrection));
        if (correction > 0) {
          amLastSeconds = estimated + correction;
          amLastAtMs = now;
          amPlaying = true;
        }
      } else if (phaseDelta < -AM_LEAD_PULLBACK_DEADBAND_S) {
        // Free-run ahead of MusicKit (common after next-track). Pull back.
        const lead = -phaseDelta;
        if (lead >= AM_LEAD_SOFT_SNAP_S) {
          amLeadSnapConfirmations += 1;
          if (amLeadSnapConfirmations >= AM_LEAD_SOFT_SNAP_CONFIRMATIONS) {
            amResetClock(sample, true);
            return;
          }
        } else {
          amLeadSnapConfirmations = 0;
        }
        // Gentle pullback toward MusicKit (stronger than forward correction).
        const pull = Math.min(lead, Math.max(0.02, sampleElapsedSeconds * 0.35));
        amLastSeconds = Math.max(0, estimated - pull);
        amLastAtMs = now;
        amPlaying = true;
        // Allow reporting slightly lower than last snapshot when correcting lead.
        amLastSnapshotSeconds = Math.min(amLastSnapshotSeconds, amLastSeconds);
      } else {
        amLeadSnapConfirmations = 0;
      }
      return;
    }

    if (!amPendingBackward) {
      amPendingBackward = {
        sampleSeconds: sample,
        observedAt: now,
        confirmations: 1,
      };
      return;
    }

    const pending = amPendingBackward;
    const expectedCandidate = pending.sampleSeconds
      + Math.max(0, now - pending.observedAt) / 1000;
    if (Math.abs(sample - expectedCandidate) <= AM_BACKWARD_CONFIRM_TOL_S) {
      if (pending.confirmations + 1 >= AM_BACKWARD_CONFIRMATIONS) {
        amResetClock(sample, true);
      } else {
        pending.confirmations += 1;
      }
      return;
    }

    amPendingBackward = backwardSeekCandidate
      ? { sampleSeconds: sample, observedAt: now, confirmations: 1 }
      : null;
  }

  /**
   * Apple Music web clock via MusicKit free-run (+ identity).
   * Ported from apps/lyric-stage AppleMusicPlaybackAdapter.
   */
  function sampleAppleMusicPlatformClock(): Record<string, unknown> | null {
    if (!isAppleMusicHost()) return null;
    const instance = readMusicKitInstance();
    const nowPlaying = readNowPlayingItem(instance);
    const mediaExternalIdHint = readAppleMusicCatalogId()
      ?? readCatalogIdFromMediaItem(nowPlaying)
      ?? readAppleMusicCatalogIdFromDom();
    const mediaKey = mediaExternalIdHint;

    // Track change: fully invalidate free-run (userscript nowPlayingItemDidChange).
    // Partial reset left amLastSnapshotSeconds / sticky playing on the previous
    // track, so the next song often ran ~1s ahead until a manual seek.
    if (mediaKey && amMediaKey && mediaKey !== amMediaKey) {
      amHardInvalidateClock();
    }
    if (mediaKey) amMediaKey = mediaKey;

    if (!instance) {
      const pos = amClockInit ? Math.max(0, amEstimateSeconds() * 1000) : 0;
      if (amClockInit) amLastSnapshotSeconds = pos / 1000;
      return {
        type: 'clock-sample',
        available: true,
        positionMs: pos,
        durationMs: readDurationMsFromItem(nowPlaying),
        playbackState: amPlaying ? 'playing' : 'paused',
        rate: 1,
        seeking: false,
        sourceKind: 'platform-api',
        confidence: mediaExternalIdHint ? 0.45 : 0.2,
        mediaExternalIdHint,
        mediaCount: pruneMedia().length,
      };
    }

    let rawSeconds = Number.NaN;
    let durationMs: number | null = readDurationMsFromItem(nowPlaying);
    let rate = 1;
    let seeking = false;
    let ended = false;
    let mkPlaying = false;

    try {
      const player = isRecord(instance.player) ? instance.player : null;
      const time = Number(instance.currentPlaybackTime ?? player?.currentPlaybackTime);
      if (Number.isFinite(time) && time >= 0) rawSeconds = time;
      const durationSec = Number(
        instance.currentPlaybackDuration ?? player?.currentPlaybackDuration,
      );
      if (Number.isFinite(durationSec) && durationSec > 0) {
        durationMs = durationSec * 1000;
      }
      const playbackRate = Number(
        instance.playbackRate
        ?? instance.currentPlaybackRate
        ?? player?.playbackRate
        ?? 1,
      );
      if (Number.isFinite(playbackRate) && playbackRate > 0) rate = playbackRate;

      const state = Number(instance.playbackState ?? player?.playbackState);
      mkPlaying = instance.isPlaying === true
        || player?.isPlaying === true
        || state === 2;
      seeking = state === 6
        || instance.seekInProgress === true
        || player?.seekInProgress === true;
      ended = state === 5 || state === 10;
    } catch {
      // keep free-run estimate
    }

    // Detect whether MusicKit time is actually advancing (truth for "playing").
    // Apple's in-page lyrics track the media clock; isPlaying alone is unreliable
    // on window blur (click outside the page without hiding the tab).
    if (Number.isFinite(rawSeconds)) {
      if (
        Number.isFinite(amPrevRawForAdvance)
        && rawSeconds > amPrevRawForAdvance + 0.08
      ) {
        amRawAdvanceStreak = Math.min(8, amRawAdvanceStreak + 1);
        amRawFrozenStreak = 0;
      } else if (
        Number.isFinite(amPrevRawForAdvance)
        && Math.abs(rawSeconds - amPrevRawForAdvance) < 0.03
      ) {
        amRawFrozenStreak = Math.min(12, amRawFrozenStreak + 1);
        if (amRawFrozenStreak >= 3) amRawAdvanceStreak = 0;
      }
      amPrevRawForAdvance = rawSeconds;
    }
    const rawAdvancing = amRawAdvanceStreak >= 1;
    const rawFrozen = amRawFrozenStreak >= 5;
    const rawLikelyPaused = amRawFrozenStreak >= 2 && !rawAdvancing;
    const unfocused = amPageUnfocused();

    // Effective playing — prefer media motion over isPlaying flag.
    //
    // Root cause of "pause but lyrics keep scrolling": while focused, we used to
    // sticky-keep free-run when `!mkPlaying && !rawFrozen` until 5 pause samples
    // AND rawFrozen≥5. Free-run kept advancing amLastSeconds the whole time, so
    // a real pause still looked like playing for ~1s+ and never fully stopped if
    // pause confirmations never ran (isPlaying stayed true).
    //
    // Sticky free-run is ONLY for blur/unfocus (MusicKit lies about isPlaying).
    // When focused: MusicKit paused + raw time not advancing → hard pause.
    let isPlaying = !ended && !seeking && (
      mkPlaying
      || rawAdvancing
      // Sticky only across blur/unfocus until time truly freezes.
      || (amPlaying && unfocused && !rawFrozen)
    );
    // Focused user pause: stop free-run as soon as MK says paused and time stalls.
    const forceFocusedPause = !unfocused
      && !mkPlaying
      && !rawAdvancing
      && (rawLikelyPaused || rawFrozen);
    if (forceFocusedPause) {
      isPlaying = false;
    }

    amObserveSample(rawSeconds, isPlaying, forceFocusedPause);

    let positionSeconds = amEstimateSeconds();
    // While free-run playing, never report behind the last snapshot.
    if (amPlaying && amClockInit) {
      positionSeconds = Math.max(amLastSnapshotSeconds, positionSeconds);
    }
    if (durationMs && durationMs > 0) {
      positionSeconds = Math.min(positionSeconds, durationMs / 1000);
    }
    amLastSnapshotSeconds = positionSeconds;
    const positionMs = Math.max(0, positionSeconds * 1000);

    // Publish sticky free-run play state so the lyric window keeps coasting
    // even if content sampling slows under blur throttling.
    const playbackState = ended
      ? 'ended'
      : seeking
        ? 'buffering'
        : amPlaying
          ? 'playing'
          : 'paused';

    return {
      type: 'clock-sample',
      available: true,
      positionMs,
      durationMs,
      playbackState,
      rate,
      seeking: seeking && !unfocused,
      sourceKind: 'platform-api',
      confidence: mediaExternalIdHint
        ? (Number.isFinite(rawSeconds) && rawSeconds > 0.35 ? 0.98 : 0.8)
        : 0.5,
      mediaExternalIdHint,
      mediaCount: pruneMedia().length,
    };
  }

  /**
   * NetEase keeps the real clock on an unattached HTMLAudioElement hung off
   * window.player. When the bridge installs after play starts, Audio()/play()
   * patches may have missed construction — walk the player graph each sample.
   */
  function sampleNeteasePlatformClock(): Record<string, unknown> | null {
    const host = readNeteasePlayingState();
    try {
      const player = (window as unknown as { player?: unknown }).player;
      if (player) findMediaInObject(player);
    } catch {
      // ignore
    }
    // Re-scan connected media; unattached nodes only appear via remember().
    try {
      document.querySelectorAll('audio, video').forEach((node) => {
        remember(node as HTMLMediaElement);
      });
    } catch {
      // ignore
    }

    const media = pickMedia();
    if (!media) {
      // No media element yet — identity alone is not a clock sample.
      return null;
    }

    let positionMs: number | null = null;
    let durationMs: number | null = null;
    let paused = true;
    let ended = false;
    let seeking = false;
    let rate = 1;
    try {
      positionMs = Number.isFinite(media.currentTime)
        ? Math.max(0, media.currentTime * 1000)
        : null;
      durationMs = Number.isFinite(media.duration) && media.duration > 0
        ? media.duration * 1000
        : host.durationMs;
      paused = Boolean(media.paused);
      ended = Boolean(media.ended);
      seeking = Boolean(media.seeking);
      rate = Number.isFinite(media.playbackRate) ? media.playbackRate : 1;
    } catch {
      return null;
    }
    if (positionMs === null) return null;

    // Prefer host play flag when media.paused is stale (common mid-track).
    if (host.playing === true) paused = false;
    if (host.playing === false && !ended) paused = true;

    const playbackState = ended
      ? 'ended'
      : seeking
        ? 'buffering'
        : paused
          ? 'paused'
          : 'playing';
    const mediaExternalIdHint = host.trackId ?? readNeteaseIdentity();
    return {
      type: 'clock-sample',
      available: true,
      positionMs,
      durationMs,
      playbackState,
      rate,
      seeking,
      sourceKind: 'platform-api',
      confidence: mediaExternalIdHint ? 0.96 : 0.88,
      mediaExternalIdHint,
      mediaCount: pruneMedia().length,
    };
  }

  function extractQqSongMid(value: string | null | undefined): string | null {
    if (!value) return null;
    let decoded = value;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      // keep raw
    }
    const match = decoded.match(/(?:songDetail\/|[?&]songmid=)([0-9A-Za-z]{14})(?:[/?&#.]|$)/i);
    if (match?.[1]) return match[1];
    const mediaMatch = decoded.match(
      /(?:M800|M500|C400|C200|O600|O400|O200|F000|A000|RS02)([0-9A-Za-z]{14})(?:\.|[?&#]|$)/i,
    );
    return mediaMatch?.[1] ?? null;
  }

  /**
   * QQ Music web (y.qq.com) plays through a React host + custom WebAudio core.
   * It often constructs empty HTMLAudioElement shells that never receive a src /
   * currentTime, so media-element hooks alone report nothing while the UI plays.
   * Walk the .mod_player React fiber for the class component that owns
   * playSongData + player.audio and sample that platform API instead.
   */
  function findQqPlayerHost(): {
    readonly playSongData?: {
      readonly isPlay?: boolean;
      readonly index?: number;
      readonly songList?: ReadonlyArray<{
        readonly mid?: string;
        readonly name?: string;
        readonly interval?: number;
        readonly playTime?: string;
      }>;
    };
    readonly state?: {
      readonly playStatus?: number;
      readonly currentTime?: number;
      readonly progressTime?: number;
    };
    readonly player?: {
      readonly isPlay?: boolean;
      readonly currentMid?: string;
      readonly currentTime?: number;
      readonly duration?: number;
      readonly audio?: {
        readonly currentTime?: number;
        readonly duration?: number;
        readonly paused?: boolean;
        readonly state?: number;
        readonly tryPlay?: boolean;
        readonly _mannualPaused?: boolean;
        readonly _seeking?: boolean;
        readonly core?: {
          readonly ctx?: { readonly currentTime?: number; readonly state?: string };
        };
        readonly sound?: {
          readonly _startTime?: number;
          readonly _seek?: number;
          readonly _rate?: number;
        };
      };
      readonly ontimeupdate?: (cb: (...args: unknown[]) => void) => void;
    };
    readonly tryPlayBeginTime?: number;
    readonly currentTime?: number;
  } | null {
    try {
      const root = document.querySelector('.mod_player');
      if (!root) return null;
      const fiberKey = Object.keys(root).find((key) => key.startsWith('__reactFiber$'));
      if (!fiberKey) return null;
      type Fiber = {
        stateNode?: unknown;
        child?: Fiber | null;
        sibling?: Fiber | null;
        return?: Fiber | null;
      };
      const start = (root as unknown as Record<string, Fiber | undefined>)[fiberKey];
      if (!start) return null;
      const queue: Fiber[] = [start];
      const seen = new Set<Fiber>();
      let steps = 0;
      while (queue.length > 0 && steps < 800) {
        steps += 1;
        const fiber = queue.shift();
        if (!fiber || seen.has(fiber)) continue;
        seen.add(fiber);
        const node = fiber.stateNode as {
          player?: { audio?: unknown };
          playSongData?: unknown;
        } | null;
        if (node && node.player && (node.player.audio || node.playSongData)) {
          return node as ReturnType<typeof findQqPlayerHost>;
        }
        if (fiber.child) queue.push(fiber.child);
        if (fiber.sibling) queue.push(fiber.sibling);
        if (fiber.return) queue.push(fiber.return);
      }
    } catch {
      // ignore
    }
    return null;
  }

  function readQqFiberTimeOffsetSeconds(): number | null {
    try {
      const root = document.querySelector('.mod_player');
      if (!root) return null;
      const fiberKey = Object.keys(root).find((key) => key.startsWith('__reactFiber$'));
      if (!fiberKey) return null;
      type Fiber = {
        memoizedProps?: { currentTimeOffset?: unknown };
        child?: Fiber | null;
        sibling?: Fiber | null;
      };
      const start = (root as unknown as Record<string, Fiber | undefined>)[fiberKey];
      if (!start) return null;
      const queue: Fiber[] = [start];
      const seen = new Set<Fiber>();
      let steps = 0;
      let best: number | null = null;
      while (queue.length > 0 && steps < 500) {
        steps += 1;
        const fiber = queue.shift();
        if (!fiber || seen.has(fiber)) continue;
        seen.add(fiber);
        const offset = fiber.memoizedProps?.currentTimeOffset;
        if (typeof offset === 'number' && Number.isFinite(offset) && offset >= 0) {
          best = offset;
        }
        if (fiber.child) queue.push(fiber.child);
        if (fiber.sibling) queue.push(fiber.sibling);
      }
      return best;
    } catch {
      return null;
    }
  }

  function deriveQqWebAudioSeconds(audio: {
    readonly paused?: boolean;
    readonly _mannualPaused?: boolean;
    readonly core?: {
      readonly ctx?: { readonly currentTime?: number; readonly state?: string };
    };
    readonly sound?: {
      readonly _startTime?: number;
      readonly _seek?: number;
      readonly _rate?: number;
    };
  }): number | null {
    try {
      const sound = audio.sound;
      const ctx = audio.core?.ctx;
      if (!sound) return null;
      const seek = Number(sound._seek);
      const start = Number(sound._startTime);
      const rate = Number(sound._rate);
      const safeRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
      const safeSeek = Number.isFinite(seek) && seek >= 0 ? seek : 0;
      const paused = Boolean(audio.paused || audio._mannualPaused);
      if (paused || !ctx || !Number.isFinite(ctx.currentTime) || !(start > 0)) {
        return safeSeek > 0 ? safeSeek : null;
      }
      const derived = safeSeek + (Number(ctx.currentTime) - start) * safeRate;
      return Number.isFinite(derived) && derived >= 0 ? derived : null;
    } catch {
      return null;
    }
  }

  let qqTimeUpdateHooked = false;
  let qqLastTimeUpdateSec: number | null = null;
  let qqLastTimeUpdateWallMs: number | null = null;
  let qqLastAbsoluteSec: number | null = null;
  let qqLastAbsoluteWallMs: number | null = null;
  let qqLastHostAbsSec: number | null = null;
  /** Wall clock when host/state absolute last advanced by a meaningful delta. */
  let qqLastHostAdvanceWallMs: number | null = null;
  let qqLastIsPlay = false;
  /**
   * Free-run may fill gaps between sparse host ticks (~1 Hz), but must not invent
   * minutes of progress when QQ freezes host.currentTime mid-track (UI also stuck).
   */
  const QQ_FREE_RUN_MAX_COAST_MS = 2800;

  function noteQqTimeUpdate(sec: number): void {
    if (!(typeof sec === 'number' && Number.isFinite(sec) && sec >= 0)) return;
    qqLastTimeUpdateSec = sec;
    qqLastTimeUpdateWallMs = performance.now();
  }

  function ensureQqTimeUpdateHook(host: NonNullable<ReturnType<typeof findQqPlayerHost>>): void {
    if (qqTimeUpdateHooked) return;
    const player = host.player;
    if (!player || typeof player.ontimeupdate !== 'function') return;
    try {
      player.ontimeupdate((...args: unknown[]) => {
        const first = args[0];
        if (typeof first === 'number' && Number.isFinite(first) && first >= 0) {
          // Do not mutate free-run anchors here: a stale callback must not pin
          // the published timeline above a live host.currentTime.
          noteQqTimeUpdate(first);
          return;
        }
        if (first && typeof first === 'object') {
          const record = first as Record<string, unknown>;
          for (const key of ['currentTime', 'time', 'position', 't', 'sec', 'seconds']) {
            const value = record[key];
            if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
              noteQqTimeUpdate(value);
              return;
            }
          }
        }
        for (const arg of args) {
          if (typeof arg === 'number' && Number.isFinite(arg) && arg >= 0) {
            noteQqTimeUpdate(arg);
            return;
          }
        }
      });
      qqTimeUpdateHooked = true;
    } catch {
      // ignore
    }
  }

  function resolveQqSongMid(
    host: NonNullable<ReturnType<typeof findQqPlayerHost>>,
    song: { readonly mid?: string } | null,
  ): string | null {
    const direct = host.player?.currentMid ?? song?.mid ?? null;
    if (typeof direct === 'string' && /^[0-9A-Za-z]{14}$/.test(direct)) return direct;

    try {
      const list = host.playSongData?.songList;
      if (list) {
        for (const item of list) {
          if (item?.mid && /^[0-9A-Za-z]{14}$/.test(item.mid)) return item.mid;
        }
      }
    } catch {
      // ignore
    }

    try {
      const playUrlMap = (host.player as { playUrlMap?: Record<string, unknown> } | undefined)?.playUrlMap;
      if (playUrlMap && typeof playUrlMap === 'object') {
        for (const key of Object.keys(playUrlMap)) {
          if (/^[0-9A-Za-z]{14}$/.test(key)) return key;
        }
      }
    } catch {
      // ignore
    }

    try {
      const hrefMid = extractQqSongMid(window.location.href);
      if (hrefMid) return hrefMid;
    } catch {
      // ignore
    }

    try {
      const raw = window.localStorage?.getItem('playSongData');
      if (raw) {
        const parsed = JSON.parse(raw) as {
          value?: { songList?: Array<{ mid?: string }>; index?: number };
          songList?: Array<{ mid?: string }>;
          index?: number;
        };
        const bag = parsed.value ?? parsed;
        const idx = typeof bag.index === 'number' ? bag.index : 0;
        const candidate = bag.songList?.[idx]?.mid ?? bag.songList?.[0]?.mid;
        if (typeof candidate === 'string' && /^[0-9A-Za-z]{14}$/.test(candidate)) return candidate;
      }
    } catch {
      // ignore
    }

    return null;
  }

  function resolveQqDurationSec(
    host: NonNullable<ReturnType<typeof findQqPlayerHost>>,
    song: { readonly interval?: number; readonly playTime?: string } | null,
    tryPlay: boolean,
    tryBegin: number,
  ): number | null {
    if (typeof song?.interval === 'number' && song.interval > 0) return song.interval;
    if (typeof song?.playTime === 'string') {
      const match = song.playTime.match(/^(\d+):(\d{2})$/);
      if (match) {
        const sec = Number(match[1]) * 60 + Number(match[2]);
        if (sec > 0) return sec;
      }
    }
    const audioDuration = host.player?.audio?.duration;
    if (typeof audioDuration === 'number' && audioDuration > 0) {
      return tryPlay ? tryBegin + audioDuration : audioDuration;
    }
    const playerDuration = host.player?.duration;
    if (typeof playerDuration === 'number' && playerDuration > 0) {
      return tryPlay ? tryBegin + playerDuration : playerDuration;
    }
    return null;
  }

  function sampleQqPlatformClock(): Record<string, unknown> | null {
    const host = findQqPlayerHost();
    if (!host) return null;
    ensureQqTimeUpdateHook(host);

    const playSongData = host.playSongData;
    const index = typeof playSongData?.index === 'number' ? playSongData.index : 0;
    const song = playSongData?.songList?.[index]
      ?? playSongData?.songList?.[0]
      ?? null;
    const mediaExternalIdHint = resolveQqSongMid(host, song);

    const audio = host.player?.audio;
    const tryPlay = Boolean(audio?.tryPlay);
    const tryBegin = typeof host.tryPlayBeginTime === 'number' && host.tryPlayBeginTime >= 0
      ? host.tryPlayBeginTime
      : 0;

    // Absolute timeline sources (track position in seconds). Observed on QQ:
    // - host.currentTime / host.state.currentTime advance while playing (authoritative)
    // - player.ontimeupdate callbacks pass absolute seconds but can go stale
    // - React props currentTimeOffset mirrors the UI absolute second
    // Relative sources (try-play window / WebAudio core) need tryBegin added.
    // host.currentTime can be 0 at track start; treat finite >= 0 as valid when present.
    const hostHasTime = typeof host.currentTime === 'number' && Number.isFinite(host.currentTime);
    const hostAbs = hostHasTime && host.currentTime! >= 0 ? host.currentTime! : null;
    const stateAbs = typeof host.state?.currentTime === 'number'
      && Number.isFinite(host.state.currentTime)
      && host.state.currentTime >= 0
      ? host.state.currentTime
      : null;
    // Drop stale timeupdate samples: max()-selection previously pinned the clock
    // at a leftover ~80s value while host.currentTime advanced from 20→45.
    const TIMEUPDATE_FRESH_MS = 2500;
    const updateAbs = qqLastTimeUpdateSec !== null
      && qqLastTimeUpdateSec >= 0
      && qqLastTimeUpdateWallMs !== null
      && (performance.now() - qqLastTimeUpdateWallMs) <= TIMEUPDATE_FRESH_MS
      ? qqLastTimeUpdateSec
      : null;
    const fiberAbs = readQqFiberTimeOffsetSeconds();

    let relativeSec: number | null = null;
    if (audio && typeof audio.currentTime === 'number' && Number.isFinite(audio.currentTime) && audio.currentTime > 0) {
      relativeSec = audio.currentTime;
    }
    if (relativeSec === null && audio) {
      relativeSec = deriveQqWebAudioSeconds(audio);
    }

    type QqPositionSource =
      | 'host'
      | 'state'
      | 'timeupdate'
      | 'fiber'
      | 'relative'
      | 'free-run'
      | 'none';
    let absoluteSec: number | null = null;
    let positionSource: QqPositionSource = 'none';

    // Prefer live host/state over timeupdate/fiber. Within a tier, take the max
    // so a just-applied seek on one field is not lost to a lagging twin.
    // Never let a stale higher absolute (old timeupdate) beat a live host time.
    // When host is frozen, prefer relative WebAudio if it still advances.
    type Candidate = { value: number; source: QqPositionSource; tier: number };
    const candidates: Candidate[] = [];
    if (hostAbs !== null) candidates.push({ value: hostAbs, source: 'host', tier: 0 });
    if (stateAbs !== null) candidates.push({ value: stateAbs, source: 'state', tier: 0 });
    if (updateAbs !== null) candidates.push({ value: updateAbs, source: 'timeupdate', tier: 1 });
    if (fiberAbs !== null && fiberAbs >= 0) {
      candidates.push({ value: fiberAbs, source: 'fiber', tier: 1 });
    }
    if (candidates.length > 0) {
      candidates.sort((a, b) => {
        if (a.tier !== b.tier) return a.tier - b.tier;
        return b.value - a.value;
      });
      absoluteSec = candidates[0]!.value;
      positionSource = candidates[0]!.source;
    } else if (relativeSec !== null) {
      absoluteSec = tryPlay ? tryBegin + relativeSec : relativeSec;
      positionSource = 'relative';
    } else if (typeof host.player?.currentTime === 'number' && host.player.currentTime >= 0) {
      absoluteSec = host.player.currentTime;
      positionSource = 'host';
    }

    const durationSec = resolveQqDurationSec(host, song, tryPlay, tryBegin);
    const durationMs = durationSec !== null ? durationSec * 1000 : null;

    const isPlay = Boolean(
      host.player?.isPlay
      ?? playSongData?.isPlay
      ?? (host.state?.playStatus === 1),
    );
    // Prefer host play flags: custom audio.paused is often wrong while UI is paused.
    const paused = !isPlay;
    const seeking = Boolean(audio?._seeking);
    const playbackState = seeking
      ? 'buffering'
      : paused
        ? 'paused'
        : 'playing';

    // QQ host fields often only refresh on seek / timeupdate ticks. While playing,
    // free-run fills short gaps between host ticks. Host may freeze mid-track
    // (same hostT + UI time for a long stretch) while isPlay stays true — free-run
    // must NOT invent minutes of progress past that freeze.
    const nowWall = performance.now();
    const hostPrimary = hostAbs !== null
      ? hostAbs
      : stateAbs !== null
        ? stateAbs
        : null;
    const hostAdvanced = hostPrimary !== null
      && (
        qqLastHostAbsSec === null
        || Math.abs(hostPrimary - qqLastHostAbsSec) >= 0.05
      );
    if (hostPrimary !== null) {
      if (hostAdvanced) {
        qqLastHostAdvanceWallMs = nowWall;
      }
      qqLastHostAbsSec = hostPrimary;
    }
    const msSinceHostAdvance = qqLastHostAdvanceWallMs === null
      ? null
      : nowWall - qqLastHostAdvanceWallMs;
    const hostLooksFrozen = isPlay
      && hostPrimary !== null
      && !hostAdvanced
      && msSinceHostAdvance !== null
      && msSinceHostAdvance > 400;
    // Allow free-run while host is advancing or briefly sparse. If host never
    // reported, still allow free-run from relative/timeupdate anchors.
    const freeRunAllowed = isPlay && (
      msSinceHostAdvance === null
      || msSinceHostAdvance <= QQ_FREE_RUN_MAX_COAST_MS
    );

    // If host is frozen but WebAudio relative time still advances past host,
    // prefer relative (real audio progress). Small/noisy relative shells stay out.
    if (hostLooksFrozen && relativeSec !== null && hostPrimary !== null) {
      const relAbs = tryPlay ? tryBegin + relativeSec : relativeSec;
      if (Number.isFinite(relAbs) && relAbs > hostPrimary + 0.35) {
        absoluteSec = relAbs;
        positionSource = 'relative';
      }
    }

    if (isPlay && absoluteSec !== null) {
      // Hard pin: host frozen beyond coast budget → host absolute is truth (stall).
      if (hostLooksFrozen && !freeRunAllowed && hostPrimary !== null && positionSource !== 'relative') {
        absoluteSec = hostPrimary;
        positionSource = 'host';
        qqLastAbsoluteSec = absoluteSec;
        qqLastAbsoluteWallMs = nowWall;
      } else {
        if (
          freeRunAllowed
          && qqLastIsPlay
          && qqLastAbsoluteSec !== null
          && qqLastAbsoluteWallMs !== null
          && absoluteSec + 0.05 < qqLastAbsoluteSec
        ) {
          const wallDeltaSec = Math.max(0, (nowWall - qqLastAbsoluteWallMs) / 1000);
          const regressionSec = qqLastAbsoluteSec - absoluteSec;
          // Ignore small regressions from free-run advance between host ticks.
          const ignoreBudgetSec = Math.max(1.2, wallDeltaSec + 0.75);
          if (regressionSec < ignoreBudgetSec) {
            absoluteSec = qqLastAbsoluteSec;
          }
        }
        if (
          freeRunAllowed
          && qqLastIsPlay
          && qqLastAbsoluteSec !== null
          && qqLastAbsoluteWallMs !== null
          && Math.abs(absoluteSec - qqLastAbsoluteSec) < 0.35
        ) {
          const projected = qqLastAbsoluteSec + (nowWall - qqLastAbsoluteWallMs) / 1000;
          // Cap projection to the free-run coast window from last host advance.
          const maxCoastSec = QQ_FREE_RUN_MAX_COAST_MS / 1000;
          const hostFloor = hostPrimary ?? qqLastAbsoluteSec;
          const maxProjected = hostFloor + maxCoastSec + 0.25;
          const capped = Math.min(projected, maxProjected);
          if (capped > absoluteSec) {
            absoluteSec = capped;
            positionSource = 'free-run';
          }
        }
        qqLastAbsoluteSec = absoluteSec;
        qqLastAbsoluteWallMs = nowWall;
      }
    } else if (!isPlay) {
      if (absoluteSec !== null) {
        qqLastAbsoluteSec = absoluteSec;
        qqLastAbsoluteWallMs = nowWall;
      }
    } else if (
      isPlay
      && absoluteSec === null
      && freeRunAllowed
      && qqLastAbsoluteSec !== null
      && qqLastAbsoluteWallMs !== null
    ) {
      const projected = qqLastAbsoluteSec + (nowWall - qqLastAbsoluteWallMs) / 1000;
      const hostFloor = hostPrimary ?? qqLastAbsoluteSec;
      absoluteSec = Math.min(projected, hostFloor + QQ_FREE_RUN_MAX_COAST_MS / 1000 + 0.25);
      positionSource = 'free-run';
      qqLastAbsoluteSec = absoluteSec;
      qqLastAbsoluteWallMs = nowWall;
    }
    qqLastIsPlay = isPlay;

    if (absoluteSec === null && !isPlay && mediaExternalIdHint === null) {
      return null;
    }

    if (absoluteSec !== null && durationSec !== null) {
      absoluteSec = Math.min(absoluteSec, durationSec);
    }

    const positionMs = absoluteSec !== null
      ? Math.max(0, absoluteSec * 1000)
      : null;

    let confidence = 0.72;
    if (positionSource === 'fiber' || positionSource === 'free-run') confidence = 0.8;
    if (positionSource === 'relative') confidence = 0.9;
    if (positionSource === 'host' || positionSource === 'state' || positionSource === 'timeupdate') {
      confidence = 0.94;
    }
    if (mediaExternalIdHint) confidence = Math.min(0.98, confidence + 0.04);
    if (durationMs !== null) confidence = Math.min(0.98, confidence + 0.01);
    if (positionMs === null) confidence = 0.4;

    return {
      type: 'clock-sample',
      available: positionMs !== null,
      positionMs,
      durationMs,
      playbackState,
      rate: 1,
      seeking,
      sourceKind: 'platform-api',
      confidence,
      mediaExternalIdHint,
      mediaCount: pruneMedia().length,
    };
  }

  function scoreMedia(media: HTMLMediaElement): number {
    try {
      // Apple Music homepage / browse embeds short looping promo <video>s
      // (~9s). Those must never beat MusicKit — userscript only reads MusicKit.
      if (isAppleMusicHost()) {
        if (media.tagName === 'VIDEO') return -100;
        // Even <audio> on AM web is usually not the real player; prefer MusicKit.
        return -50;
      }
      let score = 0;
      const hasSource = Boolean(media.currentSrc || media.src);
      const hasDuration = Number.isFinite(media.duration) && media.duration > 0;
      const t = Number(media.currentTime);
      if (hasSource) score += 4;
      if (hasDuration) score += 4;
      if (!media.paused && !media.ended) score += 8;
      // Strongly prefer media that has already advanced — empty shells stay at 0.
      if (Number.isFinite(t) && t > 0.25) score += 12;
      if (Number.isFinite(t) && t > 5) score += 4;
      // Prefer real audio streams over empty companion <video> nodes.
      if (media.tagName === 'AUDIO') score += 1;
      // Short looping hero videos (promo) score poorly even off Apple hosts.
      if (
        media.tagName === 'VIDEO'
        && hasDuration
        && media.duration > 0
        && media.duration < 45
      ) {
        score -= 20;
      }
      if (!hasSource && !hasDuration) score -= 10;
      // NetEase often leaves paused shells with src but currentTime stuck at 0.
      if (media.paused && !(t > 0) && !hasDuration) score -= 8;
      return score;
    } catch {
      return -100;
    }
  }

  function pickMedia(): HTMLMediaElement | null {
    probeKnownRoots();
    const alive = pruneMedia();
    if (alive.length === 0) return null;
    let best: HTMLMediaElement | null = null;
    let bestScore = -Infinity;
    for (const media of alive) {
      const score = scoreMedia(media);
      if (score > bestScore) {
        bestScore = score;
        best = media;
      }
    }
    // Require a positive score so a zero-stuck shell is not chosen blindly.
    if (bestScore >= 4) return best;
    return alive.find((media) => {
      try {
        return Boolean(media.currentSrc || media.src)
          && Number.isFinite(media.currentTime)
          && media.currentTime > 0.25;
      } catch {
        return false;
      }
    }) ?? null;
  }

  /**
   * NetEase bottom player exposes live time as "#g_player .time em" / progress
   * width. Used only when no trusted media element advances (userscript parity).
   */
  function sampleNeteaseDomClock(): Record<string, unknown> | null {
    try {
      const host = readNeteasePlayingState();
      const root = document.querySelector('#g_player, .m-playbar, .m-player');
      if (!root) return null;

      let durationMs = host.durationMs;
      const timeText = root.querySelector('.time')?.textContent ?? '';
      // Formats: "01:23 / 03:45" or with em for current: <em>01:23</em> / 03:45
      const emText = root.querySelector('.time em')?.textContent?.trim() ?? '';
      const parts = timeText.split('/').map((part) => part.trim());
      if (!durationMs && parts[1]) {
        durationMs = parseClockToMs(parts[1]);
      }
      let positionMs = emText ? parseClockToMs(emText) : null;
      if (positionMs === null && parts[0]) {
        positionMs = parseClockToMs(parts[0]);
      }

      // Progress bar width as secondary evidence.
      const cur = root.querySelector('.m-pbar .cur, .m-pbar .barbg .cur') as HTMLElement | null;
      const width = cur?.style?.width ?? '';
      if (
        (positionMs === null || positionMs === 0)
        && width.endsWith('%')
        && durationMs
        && durationMs > 0
      ) {
        const percent = Number.parseFloat(width);
        if (Number.isFinite(percent) && percent >= 0) {
          positionMs = Math.min(durationMs, Math.max(0, (percent / 100) * durationMs));
        }
      }

      if (positionMs === null || !Number.isFinite(positionMs)) return null;
      // Ignore pure zeros unless host says paused at start.
      if (positionMs < 200 && host.playing === true) {
        // Likely stale DOM at start of play — still publish if host is playing
        // only when we have no better source (caller already tried media).
      }

      const playing = host.playing === true
        || (
          host.playing !== false
          && Boolean(
            root.querySelector('[data-action="pause"], .pas, .btnpause, .ply.pas'),
          )
        );
      return {
        type: 'clock-sample',
        available: true,
        positionMs: Math.max(0, positionMs),
        durationMs: durationMs ?? null,
        playbackState: playing ? 'playing' : 'paused',
        rate: 1,
        seeking: false,
        sourceKind: 'platform-api',
        confidence: host.trackId ? 0.72 : 0.6,
        mediaExternalIdHint: host.trackId,
        mediaCount: pruneMedia().length,
      };
    } catch {
      return null;
    }
  }

  function parseClockToMs(value: string): number | null {
    const cleaned = value.replace(/[^\d:]/g, '').trim();
    if (!cleaned) return null;
    const parts = cleaned.split(':').map((part) => Number(part));
    if (parts.some((part) => !Number.isFinite(part))) return null;
    if (parts.length === 2) {
      return Math.max(0, (parts[0]! * 60 + parts[1]!) * 1000);
    }
    if (parts.length === 3) {
      return Math.max(0, (parts[0]! * 3600 + parts[1]! * 60 + parts[2]!) * 1000);
    }
    return null;
  }

  function sampleClock(): Record<string, unknown> {
    // Always re-probe NetEase/QQ host graphs — unattached Audio() may only
    // appear after the first play if the bridge installed mid-session.
    probeKnownRoots();
    const neteaseHost = readNeteasePlayingState();

    // Apple Music FIRST: homepage/browse autoplay promo <video>s (~9s loop)
    // must never win over MusicKit (lyric-stage userscript parity).
    if (isAppleMusicHost()) {
      const applePlatform = sampleAppleMusicPlatformClock();
      if (applePlatform) return applePlatform;
      // Do not fall through to pickMedia on Apple Music — decorative media only.
      return {
        type: 'clock-sample',
        available: false,
        positionMs: null,
        durationMs: null,
        playbackState: 'unavailable',
        rate: 1,
        seeking: false,
        sourceKind: 'none',
        confidence: 0,
        mediaExternalIdHint: readAppleMusicCatalogId(),
        mediaCount: pruneMedia().length,
      };
    }

    const media = pickMedia();
    if (media) {
      let positionMs: number | null = null;
      let durationMs: number | null = null;
      let paused = true;
      let ended = false;
      let seeking = false;
      let rate = 1;
      let src = '';
      try {
        positionMs = Number.isFinite(media.currentTime)
          ? Math.max(0, media.currentTime * 1000)
          : null;
        durationMs = Number.isFinite(media.duration) && media.duration > 0
          ? media.duration * 1000
          : null;
        paused = Boolean(media.paused);
        ended = Boolean(media.ended);
        seeking = Boolean(media.seeking);
        rate = Number.isFinite(media.playbackRate) ? media.playbackRate : 1;
        src = String(media.currentSrc || media.src || '');
      } catch {
        // Fall through to platform API / unavailable.
      }

      // Reject zero-stuck shells while NetEase host says playing.
      const zeroStuck = positionMs !== null
        && positionMs < 250
        && paused
        && neteaseHost.playing === true;
      if (positionMs !== null && !zeroStuck) {
        if (neteaseHost.playing === true) paused = false;
        if (neteaseHost.playing === false && !ended) paused = true;
        if (durationMs === null && neteaseHost.durationMs !== null) {
          durationMs = neteaseHost.durationMs;
        }

        const playbackState = ended
          ? 'ended'
          : seeking
            ? 'buffering'
            : paused
              ? 'paused'
              : 'playing';
        const mediaExternalIdHint = extractQqSongMid(src)
          ?? neteaseHost.trackId
          ?? readNeteaseIdentity();
        return {
          type: 'clock-sample',
          available: true,
          positionMs,
          durationMs,
          playbackState,
          rate,
          seeking,
          sourceKind: 'media-element',
          confidence: mediaExternalIdHint ? 0.98 : 0.9,
          mediaExternalIdHint,
          mediaCount: pruneMedia().length,
        };
      }
    }

    // NetEase before QQ: y.qq.com fiber walk is expensive and irrelevant here.
    const neteasePlatform = sampleNeteasePlatformClock();
    if (neteasePlatform) {
      // Also reject zero-stuck platform media while host says playing.
      const pos = neteasePlatform.positionMs;
      if (
        !(
          typeof pos === 'number'
          && pos < 250
          && neteaseHost.playing === true
          && neteasePlatform.playbackState === 'paused'
        )
      ) {
        return neteasePlatform;
      }
    }

    const neteaseDom = sampleNeteaseDomClock();
    if (neteaseDom) return neteaseDom;

    const qqPlatform = sampleQqPlatformClock();
    if (qqPlatform) return qqPlatform;

    return {
      type: 'clock-sample',
      available: false,
      positionMs: null,
      durationMs: null,
      playbackState: 'unavailable',
      rate: 1,
      seeking: false,
      sourceKind: 'none',
      confidence: 0,
      mediaExternalIdHint: isAppleMusicHost()
        ? readAppleMusicCatalogId()
        : readNeteaseIdentity(),
      mediaCount: pruneMedia().length,
    };
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  function isId(value: unknown): value is string {
    return typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,128}$/.test(value);
  }

  const onMessage = (event: MessageEvent<unknown>): void => {
    if (
      disposed
      || event.source !== window
      || (event.origin && event.origin !== window.location.origin)
      || !isRecord(event.data)
    ) {
      return;
    }
    const request = event.data;
    if (
      request.channel !== channel
      || request.protocolVersion !== protocolVersion
      || request.direction !== 'isolated-to-main'
      || !isId(request.bridgeInstanceId)
      || typeof request.nonce !== 'string'
      || request.nonce.length < 8
      || !isId(request.requestId)
      || !Number.isSafeInteger(request.sequence)
      || seenRequestIds.has(request.requestId)
      || !isRecord(request.command)
    ) {
      return;
    }
    const clientKey = `${request.bridgeInstanceId}\u0000${request.nonce}`;
    const lastClientSequence = lastSequenceByClient.get(clientKey) ?? 0;
    if ((request.sequence as number) <= lastClientSequence) {
      return;
    }
    // Pinned inject only answers its own client.
    if (
      !openMode
      && (
        request.bridgeInstanceId !== pinnedBridgeId
        || request.nonce !== pinnedNonce
      )
    ) {
      return;
    }

    const commandType = request.command.type;
    if (
      commandType !== 'read-clock'
      && commandType !== 'teardown'
      && commandType !== 'seek'
    ) {
      return;
    }
    // seek carries targetMs; read-clock/teardown are type-only.
    if (commandType !== 'seek' && Object.keys(request.command).length !== 1) {
      return;
    }
    if (
      commandType === 'seek'
      && (
        typeof request.command.targetMs !== 'number'
        || !Number.isFinite(request.command.targetMs)
      )
    ) {
      return;
    }

    const sequence = request.sequence as number;
    lastSequenceByClient.delete(clientKey);
    lastSequenceByClient.set(clientKey, sequence);
    while (lastSequenceByClient.size > maximumTrackedClients) {
      const oldest = lastSequenceByClient.keys().next();
      if (oldest.done) break;
      lastSequenceByClient.delete(oldest.value);
    }
    seenRequestIds.add(request.requestId);
    requestOrder.push(request.requestId);
    while (requestOrder.length > maximumRememberedRequests) {
      const expired = requestOrder.shift();
      if (expired) seenRequestIds.delete(expired);
    }

    let result: Record<string, unknown>;
    if (commandType === 'teardown') {
      // Open content-script bridge stays for the page lifetime.
      result = openMode ? { type: 'ack', kept: true } : { type: 'ack' };
    } else if (commandType === 'seek') {
      result = performSeek(request.command);
    } else {
      result = sampleClock();
    }

    window.postMessage({
      channel,
      protocolVersion,
      direction: 'main-to-isolated',
      bridgeInstanceId: request.bridgeInstanceId,
      nonce: request.nonce,
      sequence,
      requestId: request.requestId,
      result,
    }, window.location.origin);

    if (commandType === 'teardown' && !openMode) {
      disposed = true;
      window.removeEventListener('message', onMessage);
      seenRequestIds.clear();
      requestOrder.length = 0;
      mediaList.length = 0;
    }
  };

  function performSeek(command: Record<string, unknown>): Record<string, unknown> {
    const targetMs = Number(command.targetMs);
    if (!Number.isFinite(targetMs) || targetMs < 0) {
      return {
        type: 'seek-result',
        ok: false,
        positionMs: null,
        method: 'none',
        reason: 'invalid-target',
      };
    }
    const seconds = targetMs / 1000;

    // Apple Music: MusicKit.seekToTime is the supported path.
    if (isAppleMusicHost()) {
      try {
        const instance = readMusicKitInstance();
        if (instance && typeof instance.seekToTime === 'function') {
          const seekResult = (instance.seekToTime as (t: number) => unknown)(
            Math.max(0, seconds),
          );
          // seekToTime may return a Promise; fire-and-forget is fine for UX.
          if (seekResult && typeof (seekResult as Promise<unknown>).then === 'function') {
            void (seekResult as Promise<unknown>).catch(() => undefined);
          }
          // Force free-run anchor to the seek target (userscript resetPlaybackClock).
          try {
            const after = Number(instance.currentPlaybackTime);
            const playing = instance.isPlaying === true
              || Number(instance.playbackState) === 2
              || amPlaying;
            const anchorSeconds = Number.isFinite(after) && after >= 0.25
              ? after
              : seconds;
            amResetClock(anchorSeconds, playing);
            amObserveSample(anchorSeconds, playing, true);
          } catch {
            amResetClock(seconds, true);
          }
          const after = Number(instance.currentPlaybackTime);
          return {
            type: 'seek-result',
            ok: true,
            positionMs: Number.isFinite(after) && after >= 0.25
              ? after * 1000
              : targetMs,
            method: 'musickit',
          };
        }
      } catch {
        // fall through
      }
    }

    // NetEase: progress-bar drag is the reliable UX path (userscript parity).
    try {
      const host = readNeteasePlayingState();
      let durationMs = host.durationMs;
      if (!(durationMs && durationMs > 0)) {
        const media = pickMedia();
        if (media && Number.isFinite(media.duration) && media.duration > 0) {
          durationMs = media.duration * 1000;
        }
      }
      if (durationMs && durationMs > 0) {
        const selectors = [
          '#g_player .m-pbar .barbg',
          '#g_player .m-pbar',
          '.m-playbar .barbg',
          '.m-playbar .m-pbar',
          '.player_progress',
          '.mod_player .player_progress',
        ];
        let bar: Element | null = null;
        for (const sel of selectors) {
          bar = document.querySelector(sel);
          if (bar) break;
        }
        if (bar instanceof HTMLElement) {
          const rect = bar.getBoundingClientRect();
          if (rect.width >= 8) {
            const ratio = Math.min(1, Math.max(0, targetMs / durationMs));
            const x = rect.left + rect.width * ratio;
            const y = rect.top + rect.height / 2;
            const opts: MouseEventInit = {
              bubbles: true,
              cancelable: true,
              view: window,
              clientX: x,
              clientY: y,
              button: 0,
              buttons: 1,
            };
            bar.dispatchEvent(new MouseEvent('mouseover', opts));
            bar.dispatchEvent(new MouseEvent('mousedown', opts));
            bar.dispatchEvent(new MouseEvent('mousemove', opts));
            bar.dispatchEvent(new MouseEvent('mouseup', opts));
            bar.dispatchEvent(new MouseEvent('click', opts));
            return {
              type: 'seek-result',
              ok: true,
              positionMs: targetMs,
              method: 'progress-bar',
            };
          }
        }
      }
    } catch {
      // fall through
    }

    // NetEase host API when available.
    try {
      const player = (window as unknown as {
        player?: {
          seek?: (sec: number) => void;
          currentTime?: number;
        };
      }).player;
      if (player && typeof player.seek === 'function') {
        player.seek(Math.max(0, seconds));
        const t = typeof player.currentTime === 'number'
          ? player.currentTime
          : seconds;
        return {
          type: 'seek-result',
          ok: true,
          positionMs: Math.max(0, t * 1000),
          method: 'netease-player',
        };
      }
    } catch {
      // fall through
    }

    // Remembered / DOM media element.
    probeKnownRoots();
    const media = pickMedia();
    if (media) {
      try {
        const capped = Number.isFinite(media.duration) && media.duration > 0
          ? Math.min(seconds, Math.max(0, media.duration - 0.05))
          : seconds;
        media.currentTime = capped;
        return {
          type: 'seek-result',
          ok: true,
          positionMs: Math.max(0, media.currentTime * 1000),
          method: 'html-media',
        };
      } catch (error) {
        return {
          type: 'seek-result',
          ok: false,
          positionMs: null,
          method: 'html-media',
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }

    return {
      type: 'seek-result',
      ok: false,
      positionMs: null,
      method: 'none',
      reason: 'no-seek-target',
    };
  }

  window.addEventListener('message', onMessage);
}
