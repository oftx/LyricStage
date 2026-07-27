/**
 * document_start MAIN-world entry. Must run before music players construct
 * unattached HTMLAudioElement (NetEase / similar). Installs prototype hooks
 * once and exposes a shared media registry for the page-clock bridge.
 *
 * Self-contained IIFE — no module imports at runtime after bundling.
 */
export function installPageClockEarlyHooks(): void {
  const storeKey = '__lyricStagePageClockMedia';
  type Store = {
    readonly version: 1;
    remember(media: HTMLMediaElement | null | undefined): void;
    getAliveMedia(): HTMLMediaElement[];
    probeKnownRoots(): void;
  };

  const existing = (window as unknown as Record<string, Store | undefined>)[storeKey];
  if (existing && existing.version === 1) return;

  const mediaList: HTMLMediaElement[] = [];
  const mediaSet = new WeakSet<HTMLMediaElement>();

  function remember(media: HTMLMediaElement | null | undefined): void {
    if (!media || mediaSet.has(media)) return;
    try {
      void media.paused;
    } catch {
      return;
    }
    mediaSet.add(media);
    mediaList.push(media);
  }

  function getAliveMedia(): HTMLMediaElement[] {
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
    return alive.slice();
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
      remember(audio);
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
    const nativeCreateElement = Document.prototype.createElement;
    Document.prototype.createElement = function patchedCreateElement(
      this: Document,
      tagName: string,
      options?: ElementCreationOptions,
    ): HTMLElement {
      const element = nativeCreateElement.call(this, tagName, options);
      if (typeof tagName === 'string') {
        const lower = tagName.toLowerCase();
        if (lower === 'audio' || lower === 'video') {
          remember(element as HTMLMediaElement);
        }
      }
      return element;
    };
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
      remember(this);
      return nativePlay.apply(this, args);
    };
    const nativePause = proto.pause;
    proto.pause = function patchedPause(this: HTMLMediaElement): void {
      remember(this);
      return nativePause.apply(this);
    };
    const nativeLoad = proto.load;
    proto.load = function patchedLoad(this: HTMLMediaElement): void {
      remember(this);
      return nativeLoad.apply(this);
    };
  } catch {
    // ignore
  }

  try {
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLMediaElement.prototype,
      'src',
    );
    if (descriptor?.set && descriptor.get) {
      Object.defineProperty(HTMLMediaElement.prototype, 'src', {
        configurable: true,
        enumerable: descriptor.enumerable === true,
        get: descriptor.get,
        set(this: HTMLMediaElement, value: string) {
          descriptor.set!.call(this, value);
          remember(this);
        },
      });
    }
  } catch {
    // ignore
  }

  try {
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLMediaElement.prototype,
      'currentTime',
    );
    if (descriptor?.get) {
      const patched: PropertyDescriptor = {
        configurable: true,
        enumerable: descriptor.enumerable === true,
        get(this: HTMLMediaElement) {
          const value = descriptor.get!.call(this) as number;
          if (
            (Number.isFinite(value) && value > 0)
            || Boolean(this.currentSrc || this.src)
          ) {
            remember(this);
          }
          return value;
        },
      };
      if (descriptor.set) {
        patched.set = function setCurrentTime(
          this: HTMLMediaElement,
          value: number,
        ) {
          remember(this);
          descriptor.set!.call(this, value);
        };
      }
      Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', patched);
    }
  } catch {
    // ignore
  }

  for (const type of [
    'play',
    'playing',
    'pause',
    'ended',
    'seeking',
    'seeked',
    'timeupdate',
    'loadedmetadata',
    'ratechange',
    'durationchange',
  ] as const) {
    window.addEventListener(type, (event) => {
      const target = event.target;
      if (target instanceof HTMLMediaElement) remember(target);
    }, true);
  }

  try {
    document.querySelectorAll('audio, video').forEach((node) => {
      remember(node as HTMLMediaElement);
    });
  } catch {
    // document may not be ready at absolute document_start
  }

  const store: Store = Object.freeze({
    version: 1 as const,
    remember,
    getAliveMedia,
    probeKnownRoots,
  });
  (window as unknown as Record<string, Store>)[storeKey] = store;
}

// Auto-run when loaded as a MAIN-world content script.
installPageClockEarlyHooks();
