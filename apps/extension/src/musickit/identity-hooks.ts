/**
 * MAIN-world Apple Music identity discovery.
 *
 * music.apple.com often keeps the active track only inside MusicKit / network
 * traffic / shadow-DOM LCD — not in the top-level URL. The userscript reads
 * MusicKit via unsafeWindow; we mirror that and also learn catalog ids from
 * fetch/XHR song URLs when MusicKit property shapes differ across builds.
 */

const STORE_KEY = '__lyricStageAppleMusicIdentity';
const MARKER = '__lyricStageAppleMusicIdentityHooksInstalled';

export interface AppleMusicIdentityStore {
  readonly version: 1;
  rememberCatalogId(id: string | null | undefined): void;
  rememberLibraryId(id: string | null | undefined): void;
  getCatalogId(): string | null;
  getLibraryId(): string | null;
  /** Best current identity (catalog preferred). */
  discover(): string | null;
}

function isAppleMusicHost(): boolean {
  try {
    const host = window.location.hostname.replace(/^www\./, '');
    return host === 'music.apple.com' || host.endsWith('.music.apple.com');
  } catch {
    return false;
  }
}

function asId(value: unknown): string {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value !== 'string') return '';
  return value.trim();
}

function isCatalogId(value: string): boolean {
  return /^\d{1,20}$/.test(value);
}

function isLibraryId(value: string): boolean {
  return /^[a-zA-Z0-9._-]{1,64}$/.test(value)
    && !isCatalogId(value)
    && value !== 'listening'
    && value !== 'unknown'
    && value !== 'current';
}

function extractCatalogIdFromText(value: string): string | null {
  const patterns = [
    /\/songs\/(\d{1,20})(?:\/|[?#]|$)/,
    /\/song\/[^/?#]+\/(\d{1,20})(?:\/|[?#]|$)/i,
    /\/song\/(\d{1,20})(?:\/|[?#]|$)/i,
    /[?&]i=(\d{1,20})(?:[&#]|$)/,
    /"catalogId"\s*:\s*"?(\d{1,20})"?/,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match?.[1] && isCatalogId(match[1])) return match[1];
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getMusicKitInstance(): Record<string, unknown> | null {
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
      raw = typeof musicKit.getInstance === 'function'
        ? musicKit.getInstance.call(musicKit)
        : null;
    } catch {
      raw = null;
    }
    if (!raw && musicKit.Instance) raw = musicKit.Instance;
    return isRecord(raw) ? raw : null;
  } catch {
    return null;
  }
}

function readNowPlayingItem(
  instance: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!instance) return null;
  const direct = instance.nowPlayingItem;
  if (isRecord(direct)) return direct;
  // Some builds expose a getter that only works via property access on player.
  try {
    const player = isRecord(instance.player) ? instance.player : null;
    if (player && isRecord(player.nowPlayingItem)) return player.nowPlayingItem;
  } catch {
    // ignore
  }
  try {
    const queue = isRecord(instance.queue) ? instance.queue : null;
    const current = queue && isRecord(queue.currentQueueItem)
      ? queue.currentQueueItem
      : null;
    if (current && isRecord(current.item)) return current.item;
    if (queue && isRecord(queue.items) && Array.isArray((queue as { items?: unknown }).items)) {
      // no position index reliably — skip
    }
  } catch {
    // ignore
  }
  return null;
}

function catalogIdFromItem(item: Record<string, unknown> | null): string | null {
  if (!item) return null;
  try {
    const attrs = isRecord(item.attributes) ? item.attributes : null;
    const playParams = attrs && isRecord(attrs.playParams)
      ? attrs.playParams
      : (isRecord(item.playParams) ? item.playParams : null);
    const candidates = [
      asId(playParams?.catalogId),
      asId(playParams?.id),
      asId(item.songId),
      asId(item.id),
      asId(attrs?.id),
    ];
    for (const candidate of candidates) {
      if (isCatalogId(candidate)) return candidate;
    }
    // Library id still useful for later relationship resolve.
    for (const candidate of candidates) {
      if (isLibraryId(candidate)) return candidate;
    }
  } catch {
    // ignore
  }
  return null;
}

function queryDeep(selector: string): Element[] {
  const results: Element[] = [];
  const visit = (root: Document | ShadowRoot | Element): void => {
    try {
      const scope = 'querySelectorAll' in root ? root : null;
      if (!scope) return;
      scope.querySelectorAll(selector).forEach((node) => {
        results.push(node);
      });
      scope.querySelectorAll('*').forEach((node) => {
        const el = node as Element & { shadowRoot?: ShadowRoot | null };
        if (el.shadowRoot) visit(el.shadowRoot);
      });
    } catch {
      // ignore
    }
  };
  visit(document);
  return results;
}

function discoverFromDom(): string | null {
  const selectors = [
    'a[href*="/song/"]',
    '[data-testid="lcd-song-link"]',
    '[data-testid="player-title"] a',
  ];
  for (const selector of selectors) {
    for (const node of queryDeep(selector)) {
      try {
        const href = node.getAttribute('href') ?? '';
        const id = extractCatalogIdFromText(href);
        // Prefer LCD / chrome containers if we can detect them.
        const inPlayer = Boolean(
          node.closest?.('amp-lcd, footer, [class*="playback-lcd"], [class*="Lcd"]'),
        );
        if (id && inPlayer) return id;
      } catch {
        // ignore
      }
    }
  }
  // Fallback: only location (not arbitrary page links).
  return extractCatalogIdFromText(window.location.href);
}

export function getAppleMusicIdentityStore(): AppleMusicIdentityStore | null {
  const store = (window as unknown as Record<string, AppleMusicIdentityStore | undefined>)[STORE_KEY];
  return store?.version === 1 ? store : null;
}

export function installAppleMusicIdentityHooks(): AppleMusicIdentityStore | null {
  if (!isAppleMusicHost()) return null;
  const existing = getAppleMusicIdentityStore();
  if (existing) return existing;
  if ((window as unknown as Record<string, boolean>)[MARKER]) {
    return getAppleMusicIdentityStore();
  }
  (window as unknown as Record<string, boolean>)[MARKER] = true;

  let lastCatalogId: string | null = null;
  let lastLibraryId: string | null = null;
  let lastSeenAtMs = 0;

  const store: AppleMusicIdentityStore = {
    version: 1,
    rememberCatalogId(id) {
      const value = asId(id);
      if (!isCatalogId(value)) return;
      lastCatalogId = value;
      lastSeenAtMs = Date.now();
    },
    rememberLibraryId(id) {
      const value = asId(id);
      if (!isLibraryId(value)) return;
      lastLibraryId = value;
      lastSeenAtMs = Date.now();
    },
    getCatalogId: () => lastCatalogId,
    getLibraryId: () => lastLibraryId,
    discover(): string | null {
      // ONLY trust live nowPlaying for the hot path.
      // After the first track, deep MusicKit scans / fetch hooks still hold
      // previous songs (queue, recommendations). Returning those made mediaId
      // thrash (catalog id ↔ library id / previous song) and karaoke stutter
      // on every song after the first.
      const instance = getMusicKitInstance();
      const item = readNowPlayingItem(instance);
      const fromItem = catalogIdFromItem(item);
      if (fromItem) {
        if (isCatalogId(fromItem)) {
          lastCatalogId = fromItem;
          lastSeenAtMs = Date.now();
          return fromItem;
        }
        // Library resource: keep last catalog id only if it was learned for
        // this same item; otherwise expose the library id for resolve.
        lastLibraryId = fromItem;
        // Prefer sticky catalog over flapping library id for the same play.
        if (lastCatalogId && Date.now() - lastSeenAtMs < 120_000) {
          return lastCatalogId;
        }
        return fromItem;
      }

      // No nowPlaying: LCD only (never browse-page song lists / network cache).
      const fromDom = discoverFromDom();
      if (fromDom) {
        lastCatalogId = fromDom;
        lastSeenAtMs = Date.now();
        return fromDom;
      }
      return null;
    },
  };

  (window as unknown as Record<string, AppleMusicIdentityStore>)[STORE_KEY] = store;

  // Do NOT learn catalog ids from arbitrary fetch/XHR/history URLs.
  // After song 1, Apple Music traffic is full of other catalog ids (queue,
  // radio, recommendations). Remembering them made discover() thrash mediaId.

  // Periodic discovery so late MusicKit configure still binds identity.
  // Once a stable catalog id is held, drop to a slow heartbeat (events cover
  // most track changes; this is only a safety net).
  try {
    let discoverIntervalMs = 1_500;
    let discoverTimer: number | null = null;
    const armDiscover = (ms: number): void => {
      if (discoverTimer !== null) window.clearInterval(discoverTimer);
      discoverIntervalMs = ms;
      discoverTimer = window.setInterval(() => {
        const id = store.discover();
        const nextMs = id && !id.startsWith('i.') ? 4_000 : 1_500;
        if (nextMs !== discoverIntervalMs) armDiscover(nextMs);
      }, ms) as unknown as number;
    };
    armDiscover(discoverIntervalMs);
  } catch {
    // ignore
  }

  // Lifecycle events (userscript parity).
  try {
    document.addEventListener('musickitloaded', () => {
      store.discover();
    });
    document.addEventListener('musickitconfigured', () => {
      store.discover();
    });
  } catch {
    // ignore
  }

  return store;
}
