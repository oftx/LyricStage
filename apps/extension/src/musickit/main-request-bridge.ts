/**
 * Self-contained MAIN-world Apple Music lyric request bridge.
 * Prefer loading as a document_start MAIN content script (open mode).
 * Must not close over module values when serialized via executeScript.
 */
export function installAppleMusicRequestBridge(): void {
  const marker = '__lyricStageAppleMusicRequestBridgeInstalled';
  if ((window as unknown as Record<string, boolean>)[marker]) return;
  (window as unknown as Record<string, boolean>)[marker] = true;

  const channel = 'lyric-stage-apple-music-request-v1';
  const protocolVersion = 1;
  const maximumRememberedRequests = 256;
  const maximumPendingRequests = 2;
  const maximumCandidates = 16;
  const maximumCandidateDepth = 8;
  const maximumTtmlLength = 4_000_000;
  const apiWaitTimeoutMs = 8_000;
  const apiPollIntervalMs = 100;
  const maximumTrackedClients = 32;
  const seenRequestIds = new Set<string>();
  const requestOrder: string[] = [];
  /**
   * Per-client (bridgeInstanceId + nonce) sequence ordering — a reloaded
   * extension's fresh client restarts at 1 and must not be dropped by a
   * global high-water mark from the previous client (P0-1). Bounded LRU.
   */
  const lastSequenceByClient = new Map<string, number>();
  let pendingRequests = 0;
  let disposed = false;

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
      || request.nonce.length < 16
      || !isId(request.requestId)
      || !Number.isSafeInteger(request.sequence)
      || seenRequestIds.has(request.requestId)
      || !isRecord(request.command)
    ) {
      return;
    }
    const clientKey = `${request.bridgeInstanceId}\u0000${request.nonce}`;
    if ((request.sequence as number) <= (lastSequenceByClient.get(clientKey) ?? 0)) {
      return;
    }

    const command = parseCommand(request.command);
    if (!command) return;
    const sequence = request.sequence as number;
    const requestId = request.requestId as string;
    lastSequenceByClient.delete(clientKey);
    lastSequenceByClient.set(clientKey, sequence);
    while (lastSequenceByClient.size > maximumTrackedClients) {
      const oldest = lastSequenceByClient.keys().next();
      if (oldest.done) break;
      lastSequenceByClient.delete(oldest.value);
    }
    seenRequestIds.add(requestId);
    requestOrder.push(requestId);
    while (requestOrder.length > maximumRememberedRequests) {
      const expired = requestOrder.shift();
      if (expired) seenRequestIds.delete(expired);
    }

    if (command.type === 'teardown') {
      // Content-script bridge stays for the page lifetime.
      postResult(sequence, requestId, request.bridgeInstanceId as string, request.nonce as string, {
        type: 'ack',
      });
      return;
    }

    if (pendingRequests >= maximumPendingRequests) {
      postResult(sequence, requestId, request.bridgeInstanceId as string, request.nonce as string, {
        type: 'error',
        code: 'busy',
        status: null,
      });
      return;
    }
    pendingRequests += 1;
    void requestLyrics(command.catalogId, command.locale).then((result) => {
      if (!disposed) {
        postResult(
          sequence,
          requestId,
          request.bridgeInstanceId as string,
          request.nonce as string,
          result,
        );
      }
    }).catch((error: unknown) => {
      if (!disposed) {
        postResult(
          sequence,
          requestId,
          request.bridgeInstanceId as string,
          request.nonce as string,
          {
            type: 'error',
            code: 'request-failed',
            status: readStatus(error),
          },
        );
      }
    }).finally(() => {
      pendingRequests = Math.max(0, pendingRequests - 1);
    });
  };

  function postResult(
    sequence: number,
    requestId: string,
    bridgeInstanceId: string,
    nonce: string,
    result: Readonly<Record<string, unknown>>,
  ): void {
    window.postMessage({
      channel,
      protocolVersion,
      direction: 'main-to-isolated',
      bridgeInstanceId,
      nonce,
      sequence,
      requestId,
      result,
    }, window.location.origin);
  }

  function asId(value: unknown): string {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) {
      return String(value);
    }
    if (typeof value !== 'string') return '';
    return value.trim();
  }

  function readNowPlayingItem(
    instance: Record<string, unknown>,
  ): Record<string, unknown> | null {
    if (isRecord(instance.nowPlayingItem)) return instance.nowPlayingItem;
    const queue = isRecord(instance.queue) ? instance.queue : null;
    const current = queue && isRecord(queue.currentQueueItem)
      ? queue.currentQueueItem
      : null;
    if (current && isRecord(current.item)) return current.item;
    return null;
  }

  /**
   * Userscript getAppleMusicCatalogId parity.
   */
  function catalogIdFromItem(item: Record<string, unknown> | null): string {
    if (!item) return '';
    const attrs = isRecord(item.attributes) ? item.attributes : null;
    const playParams = attrs && isRecord(attrs.playParams) ? attrs.playParams : null;
    return asId(playParams?.catalogId)
      || asId(playParams?.id)
      || asId(item.id);
  }

  function readIdentityStoreCatalogId(): string | null {
    try {
      const store = (window as unknown as {
        __lyricStageAppleMusicIdentity?: {
          version?: number;
          discover?: () => string | null;
          getCatalogId?: () => string | null;
        };
      }).__lyricStageAppleMusicIdentity;
      if (store?.version !== 1) return null;
      const discovered = store.discover?.() ?? store.getCatalogId?.() ?? null;
      return discovered && /^\d{1,20}$/.test(discovered) ? discovered : discovered;
    } catch {
      return null;
    }
  }

  /**
   * Library songs only expose library ids — resolve catalog relationship
   * (lyric-stage AppleMusicLyricSource.resolveAppleMusicCatalogId).
   * fallbackId may be "current" when isolated only knows applemusic:listening.
   */
  async function resolveCatalogId(
    music: (
      path: string,
      parameters: Readonly<Record<string, string>>,
    ) => Promise<unknown>,
    instance: Record<string, unknown>,
    fallbackId: string,
  ): Promise<string | null> {
    const item = readNowPlayingItem(instance);
    const direct = catalogIdFromItem(item);
    const itemId = asId(item?.id);
    const fromStore = readIdentityStoreCatalogId();
    const hint = fallbackId === 'current' || fallbackId === 'listening'
      ? ''
      : fallbackId;

    // Prefer live nowPlaying catalog id, then network-learned store, then hint.
    if (/^\d{1,20}$/.test(direct)) return direct;
    if (fromStore && /^\d{1,20}$/.test(fromStore)) return fromStore;
    if (/^\d{1,20}$/.test(hint) && hint !== itemId) return hint;

    // Library id → catalog relationship.
    const libraryId = itemId
      || (direct && !/^\d{1,20}$/.test(direct) ? direct : '')
      || (hint && !/^\d{1,20}$/.test(hint) ? hint : '')
      || (fromStore && !/^\d{1,20}$/.test(fromStore) ? fromStore : '');
    if (libraryId && !/^\d{1,20}$/.test(libraryId)) {
      try {
        const response = await music(
          `/v1/me/library/songs/${encodeURIComponent(libraryId)}`,
          { include: 'catalog' },
        );
        const status = readStatus(response);
        if (status === null || status < 400) {
          const resource = readResource(response);
          const relationships = resource && isRecord(resource.relationships)
            ? resource.relationships
            : null;
          const catalog = relationships && isRecord(relationships.catalog)
            ? relationships.catalog
            : null;
          const data = catalog && Array.isArray(catalog.data) ? catalog.data : null;
          const first = data && isRecord(data[0]) ? data[0] : null;
          const resolved = asId(first?.id);
          if (/^\d{1,20}$/.test(resolved)) return resolved;
        }
      } catch {
        // fall through
      }
    }

    if (/^\d{1,20}$/.test(direct)) return direct;
    if (/^\d{1,20}$/.test(hint)) return hint;
    return null;
  }

  async function requestLyrics(
    catalogId: string,
    locale: string,
  ): Promise<Readonly<Record<string, unknown>>> {
    const ready = await waitForMusicApi();
    if (!ready) return { type: 'error', code: 'api-unavailable', status: null };
    const { instance, music } = ready;
    if (instance.isAuthorized === false) {
      return { type: 'error', code: 'not-authorized', status: null };
    }

    // Prefer live nowPlaying resolution (userscript); isolated id is a hint.
    const resolvedId = await resolveCatalogId(music, instance, catalogId);
    if (!resolvedId) {
      return { type: 'error', code: 'no-lyrics', status: null };
    }

    const storefront = normalizeStorefront(
      instance.storefrontId ?? instance.storefrontCountryCode,
    );
    const parameters = localeParameters(locale);
    // Placeholder path first (MusicKit web historical preference), then concrete.
    const paths = [
      `/v1/catalog/{{storefrontId}}/songs/${resolvedId}/syllable-lyrics`,
      `/v1/catalog/${storefront}/songs/${resolvedId}/syllable-lyrics`,
    ];
    let response: unknown = null;
    let lastError: unknown = null;

    for (let index = 0; index < paths.length; index += 1) {
      try {
        response = await music(paths[index]!, parameters);
        const status = readStatus(response);
        if (status === 404 && index < paths.length - 1) continue;
        break;
      } catch (error) {
        lastError = error;
        const status = readStatus(error);
        if (status === 404 && index < paths.length - 1) continue;
        return errorResult(status, instance.isAuthorized);
      }
    }

    if (response === null) {
      return errorResult(readStatus(lastError), instance.isAuthorized);
    }
    const status = readStatus(response);
    if (status !== null && status >= 400) return errorResult(status, instance.isAuthorized);
    if (hasErrors(response)) return errorResult(status, instance.isAuthorized);

    const resource = readResource(response);
    if (!resource) {
      return { type: 'error', code: 'invalid-response', status: status ?? 200 };
    }
    const collected = collectCandidates(resource);
    if (collected.tooLarge) {
      return { type: 'error', code: 'lyrics-too-large', status: status ?? 200 };
    }
    if (collected.candidates.length === 0) {
      return { type: 'error', code: 'no-lyrics', status: status ?? 200 };
    }
    return {
      type: 'lyrics',
      catalogId: resolvedId,
      storefront,
      locale,
      status: status ?? 200,
      candidates: collected.candidates,
    };
  }

  async function waitForMusicApi(): Promise<{
    readonly instance: Record<string, unknown>;
    readonly music: (
      path: string,
      parameters: Readonly<Record<string, string>>,
    ) => Promise<unknown>;
  } | null> {
    const deadline = Date.now() + apiWaitTimeoutMs;
    while (!disposed) {
      try {
        const musicKit = (window as Window & {
          MusicKit?: { getInstance?: () => unknown };
        }).MusicKit;
        const rawInstance = musicKit?.getInstance?.();
        if (isRecord(rawInstance)) {
          const api = isRecord(rawInstance.api) ? rawInstance.api : null;
          const v3 = api && isRecord(api.v3) ? api.v3 : null;
          if (v3 && typeof v3.music === 'function') {
            return {
              instance: rawInstance,
              music: v3.music.bind(v3) as (
                path: string,
                parameters: Readonly<Record<string, string>>,
              ) => Promise<unknown>,
            };
          }
          if (api && typeof api.music === 'function') {
            return {
              instance: rawInstance,
              music: api.music.bind(api) as (
                path: string,
                parameters: Readonly<Record<string, string>>,
              ) => Promise<unknown>,
            };
          }
        }
      } catch {
        // MusicKit can be replaced while Apple Music navigates; retry briefly.
      }
      if (Date.now() >= deadline) return null;
      await new Promise<void>((resolve) => globalThis.setTimeout(resolve, apiPollIntervalMs));
    }
    return null;
  }

  function readResource(value: unknown): Readonly<Record<string, unknown>> | null {
    if (!isRecord(value)) return null;
    const data = value.data;
    if (Array.isArray(data) && isRecord(data[0])) return data[0];
    if (isRecord(data)) {
      if (Array.isArray(data.data) && isRecord(data.data[0])) return data.data[0];
      if (isRecord(data.resource)) return data.resource;
      if (isRecord(data.attributes)) return data;
    }
    const json = isRecord(value.json) ? value.json : null;
    return json && Array.isArray(json.data) && isRecord(json.data[0])
      ? json.data[0]
      : null;
  }

  function collectCandidates(value: unknown): {
    readonly candidates: readonly Readonly<Record<string, unknown>>[];
    readonly tooLarge: boolean;
  } {
    const candidates: Array<{ locale: string | null; ttml: string }> = [];
    const visited = new WeakSet<object>();
    let totalLength = 0;
    let tooLarge = false;

    const visit = (
      candidate: unknown,
      inheritedLocale: string | null,
      depth: number,
    ): void => {
      if (
        tooLarge
        || depth > maximumCandidateDepth
        || candidates.length >= maximumCandidates
      ) {
        return;
      }
      if (typeof candidate === 'string') {
        if (!isTtml(candidate)) return;
        if (candidates.some((entry) => entry.ttml === candidate)) return;
        totalLength += candidate.length;
        if (totalLength > maximumTtmlLength) {
          tooLarge = true;
          return;
        }
        candidates.push({ locale: inheritedLocale, ttml: candidate });
        return;
      }
      if (!candidate || typeof candidate !== 'object' || visited.has(candidate)) {
        return;
      }
      visited.add(candidate);
      if (Array.isArray(candidate)) {
        candidate.forEach((entry) => visit(entry, inheritedLocale, depth + 1));
        return;
      }
      const record = candidate as Readonly<Record<string, unknown>>;
      const recordLocale = readLocale(record) ?? inheritedLocale;
      const entries = Object.entries(record);
      for (const [key, entry] of entries) {
        if (!['ttml', 'value', 'content'].includes(key.toLowerCase())) continue;
        visit(entry, recordLocale, depth + 1);
      }
      for (const [key, entry] of entries) {
        if (
          ['ttml', 'value', 'content', 'locale', 'language', 'lang'].includes(
            key.toLowerCase(),
          )
        ) {
          continue;
        }
        visit(entry, localeFromKey(key) ?? recordLocale, depth + 1);
      }
    };

    visit(value, null, 0);
    return { candidates, tooLarge };
  }

  function localeParameters(locale: string): Readonly<Record<string, string>> {
    const rawLocale = locale.replace(/_/g, '-');
    let language = rawLocale.toLowerCase().split('-')[0] || 'en';
    let region = '';
    let script = language === 'zh'
      ? 'Hans'
      : language === 'ja'
        ? 'Kana'
        : language === 'ko'
          ? 'Hang'
          : 'Latn';
    const hasExplicitScript = /-[a-z]{4}(?:-|$)/i.test(rawLocale);
    try {
      const parsed = new Intl.Locale(rawLocale);
      language = parsed.language.toLowerCase();
      region = String(parsed.region ?? '').toLowerCase();
      script = parsed.maximize().script || script;
    } catch {
      // isolated-side protocol already validates locale shape
    }
    if (language === 'ja') script = 'Kana';
    if (language === 'ko') script = 'Hang';
    const lyricLocale = hasExplicitScript || language === 'zh'
      ? [language, script.toLowerCase(), region].filter(Boolean).join('-')
      : [language, region].filter(Boolean).join('-');
    return {
      'l[lyrics]': lyricLocale,
      'l[script]': `${language}-${script}`,
      extend: 'ttmlLocalizations',
    };
  }

  function parseCommand(value: Readonly<Record<string, unknown>>):
    | { readonly type: 'request-lyrics'; readonly catalogId: string; readonly locale: string }
    | { readonly type: 'teardown' }
    | null {
    if (value.type === 'teardown') {
      return Object.keys(value).length === 1 ? { type: 'teardown' } : null;
    }
    if (
      value.type !== 'request-lyrics'
      || Object.keys(value).length !== 3
      || typeof value.catalogId !== 'string'
      || !(
        value.catalogId === 'current'
        || (
          /^[a-zA-Z0-9._-]{1,64}$/.test(value.catalogId)
          && value.catalogId !== 'listening'
          && value.catalogId !== 'unknown'
        )
      )
      || typeof value.locale !== 'string'
      || value.locale.length > 35
      || !/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8}){0,3}$/.test(value.locale)
    ) {
      return null;
    }
    return {
      type: 'request-lyrics',
      catalogId: value.catalogId,
      locale: value.locale,
    };
  }

  function errorResult(
    status: number | null,
    isAuthorized: unknown,
  ): Readonly<Record<string, unknown>> {
    if (isAuthorized === false || status === 401 || status === 403) {
      return { type: 'error', code: 'not-authorized', status };
    }
    if (status === 404) return { type: 'error', code: 'no-lyrics', status };
    return { type: 'error', code: 'request-failed', status };
  }

  function readStatus(value: unknown): number | null {
    if (!isRecord(value)) return null;
    const status = Number(value.status ?? value.statusCode);
    return Number.isSafeInteger(status) && status >= 100 && status <= 599
      ? status
      : null;
  }

  function hasErrors(value: unknown): boolean {
    if (!isRecord(value)) return false;
    const hasValue = (candidate: unknown): boolean => Array.isArray(candidate)
      ? candidate.length > 0
      : Boolean(candidate);
    const json = isRecord(value.json) ? value.json : null;
    const data = isRecord(value.data) ? value.data : null;
    return hasValue(value.errors) || hasValue(json?.errors) || hasValue(data?.errors);
  }

  function normalizeStorefront(value: unknown): string {
    const candidate = typeof value === 'string' ? value.trim().toLowerCase() : '';
    return /^[a-z]{2}$/.test(candidate) ? candidate : 'us';
  }

  function readLocale(record: Readonly<Record<string, unknown>>): string | null {
    for (const key of ['locale', 'language', 'lang']) {
      const value = record[key];
      if (typeof value === 'string' && isLocale(value)) return value;
    }
    return null;
  }

  function localeFromKey(value: string): string | null {
    return isLocale(value) ? value : null;
  }

  function isLocale(value: string): boolean {
    return value.length <= 35
      && /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8}){0,3}$/.test(value);
  }

  function isTtml(value: string): boolean {
    const start = value.trimStart().slice(0, 32).toLowerCase();
    return start.startsWith('<tt') || start.startsWith('<?xml');
  }

  function isId(value: unknown): value is string {
    return typeof value === 'string' && /^[a-zA-Z0-9:_-]{1,128}$/.test(value);
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  window.addEventListener('message', onMessage);
}
