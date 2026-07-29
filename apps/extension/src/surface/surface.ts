import {
  createMessageEnvelopeV1,
  isSparsePlaybackAnchorV1,
  parseMessageEnvelopeV1,
  parsePlaybackPayload,
  type LyricDocumentPayloadV1,
  type SparsePlaybackAnchorV1,
} from '@lyric-stage/extension-protocol';
import {
  createLyricsPlayer,
  deriveInstrumentalGaps,
  deriveLyricDocumentCapabilities,
  isLyricsFontWeightTier,
  type LyricsPlayerController,
  type PlaybackCommands,
} from '@lyric-stage/player';
import { projectSparseAnchor } from './project-sparse-anchor.js';
import {
  attachSecondaryTracks,
  parsePrimaryDocument,
} from './parse-lyric-payload.js';
import {
  chromeLyricStorage,
  ExtensionLyricLibrary,
  type LyricLibraryIndexEntryV1,
} from '../library/extension-lyric-library.js';
import { createSparseAnchorClock } from './sparse-anchor-clock.js';
import type { PortableLyricText, LyricSearchRequest, LyricSearchResultItem, SearchPlatform, SearchType } from '@lyric-stage/platform-adapters';
import {
  clearTimingOffset,
  loadGlobalTimingOffset,
  loadStoredTimingOffset,
  OffsetLyricBinding,
  saveGlobalTimingOffset,
  saveTimingOffset,
  TIMING_OFFSET_LIMIT_MS,
} from './offset-lyric-binding.js';
import {
  NO_DOCUMENT_CAPABILITIES,
  resolveEffectiveDisplayMode,
  type LyricDisplayCapabilities,
} from './effective-display-mode.js';
import {
  FONT_WEIGHT_TIERS,
  isSurfaceBackgroundMode,
  isSurfaceDisplayMode,
  isSurfaceLayoutProfile,
  isSurfaceTheme,
  LAYOUT_PROFILE_TIERS,
  layoutProfileLabel,
  loadSurfacePreferences,
  resolveThemeAppearance,
  saveSurfacePreferences,
  type SurfaceLayoutProfile,
  type SurfacePreferences,
} from './surface-preferences.js';

export { projectSparseAnchor } from './project-sparse-anchor.js';

const surfaceId = `surface:${crypto.randomUUID()}`;
/** Embedded panel mode (in-page iframe): hide window chrome, transparent bg. */
const panelParams = new URLSearchParams(window.location.search);
const panelMode = panelParams.get('panel') === '1';
if (panelMode) {
  document.body.dataset.panel = 'true';
}
// Capability guards, not presence guards. Fullscreen inside the panel
// iframe works once the host <iframe allowfullscreen> grants it (checked
// via fullscreenEnabled). Document PiP is top-level-only, so the panel
// delegates PiP to the host content script via postMessage.
if (!document.fullscreenEnabled) {
  document.getElementById('toggle-fullscreen')?.setAttribute('hidden', '');
}

export function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const clock = createSparseAnchorClock();
const offsetBinding = new OffsetLyricBinding(clock, (positionMs) => {
  sendSeekIntent(positionMs);
});
/** Media id whose timing offset is currently loaded into the binding. */
let timingOffsetMediaId: string | null = null;
let timingSaveTimer: number | null = null;
/**
 * Site-global calibration (per platform, keyed off the current mediaId's
 * platform prefix). null = 全局 off. Resolution: per-media stored value wins;
 * otherwise the site global applies. The global never writes per-media keys;
 * adjusting while it is active saves a PER-MEDIA value (spec: that counts as
 * calibrating this track).
 */
let globalTimingOffsetMs: number | null = null;
/** True when the shown offset came from the site global (no per-media key). */
let timingRidesGlobal = false;
let player: LyricsPlayerController | null = null;
let port: chrome.runtime.Port | null = null;
let reconnectTimer: number | null = null;
let playerReady = false;
let lyricRevision = 0;
/** Last applied lyric media id — revision is only monotonic within the same media. */
let lyricMediaId: string | null = null;
/** Latest seek lifecycle state; drives the event-driven seek-status line. */
let lastSeekOutcome: string | null = null;
/** Whether current document has mergeable translation / pronunciation tracks. */
let hasTranslationTrack = false;
let hasPronunciationTrack = false;
/** Current album art URL for cover background. */
let currentCoverUrl: string | null = null;
let prefs: SurfacePreferences = loadSurfacePreferences();
/**
 * Timing capabilities of the bound document. prefs.displayMode is USER
 * INTENT; the player receives the effective mode, degraded 逐字→整行→文本
 * when the document lacks word/line timing. Degradation is never persisted,
 * so a later document with word timing restores the user's choice.
 */
let documentCapabilities: LyricDisplayCapabilities = NO_DOCUMENT_CAPABILITIES;

function effectiveDisplayMode(): SurfacePreferences['displayMode'] {
  return resolveEffectiveDisplayMode(prefs.displayMode, documentCapabilities);
}
let settingsOpen = false;
let libraryOpen = false;
let onlineSearchOpen = false;
let themeMediaQuery: MediaQueryList | null = null;
/** Avoid stacking concurrent artwork loads when toggling cover rapidly. */
let artworkRequestId = 0;

const commands: PlaybackCommands = offsetBinding.commands();
/** Declared BEFORE the boot block: wireTimingControls runs during boot, and
 * a module-tail const is still undefined then (esbuild lowers const to var,
 * so the TDZ became a silent NaN step that clamped the offset to 0 — the
 * "plus button acts as reset" bug). */
const TIMING_STEP_MS = 100;

const ui = {
  empty: document.getElementById('empty'),
  live: document.getElementById('live'),
  clock: document.getElementById('clock'),
  state: document.getElementById('state'),
  stateDot: document.getElementById('state-dot'),
  media: document.getElementById('media'),
  session: document.getElementById('session'),
  generation: document.getElementById('generation'),
  sequence: document.getElementById('sequence'),
  rate: document.getElementById('rate'),
  age: document.getElementById('age'),
  connection: document.getElementById('connection'),
  playerHost: document.getElementById('player-host'),
  seekStatus: document.getElementById('seek-status'),
  toggleTranslation: document.getElementById('toggle-translation') as HTMLButtonElement | null,
  togglePronunciation: document.getElementById('toggle-pronunciation') as HTMLButtonElement | null,
  toggleSettings: document.getElementById('toggle-settings') as HTMLButtonElement | null,
  floatChrome: document.getElementById('float-chrome'),
  surfaceToast: document.getElementById('surface-toast'),
  pipPlacard: document.getElementById('pip-placard'),
  toggleFullscreen: document.getElementById('toggle-fullscreen') as HTMLButtonElement | null,
  togglePip: document.getElementById('toggle-pip') as HTMLButtonElement | null,
  settingsPanel: document.getElementById('settings-panel'),
  libraryPanel: document.getElementById('library-panel'),
  toggleLibrary: document.getElementById('toggle-library') as HTMLButtonElement | null,
  prefFontWeight: document.getElementById('pref-font-weight'),
  prefLayoutProfile: document.getElementById('pref-layout-profile'),
  libraryMedia: document.getElementById('library-media'),
  libraryList: document.getElementById('library-list'),
  libraryIgnore: document.getElementById('library-ignore') as HTMLButtonElement | null,
  librarySearch: document.getElementById('library-search') as HTMLInputElement | null,
  timingOffsetMinus: document.getElementById('timing-offset-minus') as HTMLButtonElement | null,
  timingOffsetPlus: document.getElementById('timing-offset-plus') as HTMLButtonElement | null,
  timingOffsetValue: document.getElementById('timing-offset-value'),
  timingOffsetReset: document.getElementById('timing-offset-reset') as HTMLButtonElement | null,
  timingOffsetGlobal: document.getElementById('timing-offset-global') as HTMLButtonElement | null,
  libraryEditPanel: document.getElementById('library-edit-panel'),
  libraryEditTitle: document.getElementById('library-edit-title') as HTMLInputElement | null,
  libraryEditCreators: document.getElementById('library-edit-creators') as HTMLInputElement | null,
  libraryEditTitleAliases: document.getElementById('library-edit-title-aliases') as HTMLInputElement | null,
  libraryEditCreatorAliases: document.getElementById('library-edit-creator-aliases') as HTMLInputElement | null,
  libraryEditSave: document.getElementById('library-edit-save') as HTMLButtonElement | null,
  libraryEditCancel: document.getElementById('library-edit-cancel') as HTMLButtonElement | null,
  libraryEditText: document.getElementById('library-edit-text') as HTMLTextAreaElement | null,
  libraryEditTranslation: document.getElementById('library-edit-translation') as HTMLTextAreaElement | null,
  libraryEditStatus: document.getElementById('library-edit-status'),
  toggleOnlineSearch: document.getElementById('toggle-online-search') as HTMLButtonElement | null,
  onlineSearchPanel: document.getElementById('online-search-panel'),
  onlineSearchMedia: document.getElementById('online-search-media'),
  onlineSearchInput: document.getElementById('online-search-input') as HTMLInputElement | null,
  onlineSearchBtn: document.getElementById('online-search-btn') as HTMLButtonElement | null,
  onlineSearchList: document.getElementById('online-search-list'),
  onlineSearchStatus: document.getElementById('online-search-status'),
};

const lyricLibrary = new ExtensionLyricLibrary(chromeLyricStorage());
/** Current media identity + page title from media-meta (may lead lyrics). */
let currentMediaId: string | null = null;
let currentMediaTitle: string | null = null;
let currentMediaCreators: readonly string[] = [];
/** Manual library pick pins the document against worker lyric pushes. */
let manualLibraryLock = false;
let libraryEntriesCache: readonly LyricLibraryIndexEntryV1[] = [];

function setConnection(text: string): void {
  if (ui.connection) ui.connection.textContent = text;
}

function formatClock(ms: number): string {
  const total = Math.max(0, ms);
  const minutes = Math.floor(total / 60_000);
  const seconds = Math.floor((total % 60_000) / 1000);
  const millis = Math.floor(total % 1000);
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

function persistPrefs(): void {
  saveSurfacePreferences(prefs);
}

function applyChromeTheme(): void {
  // Use data-chrome-theme so it never collides with settings buttons' data-pref-theme.
  const appearance = resolveThemeAppearance(prefs.theme);
  document.documentElement.dataset.chromeTheme = appearance;
  applyDebugChrome();
  if (panelMode && window.parent !== window) {
    // The host page's floating-panel grip mirrors the surface theme.
    try {
      window.parent.postMessage(
        { kind: 'lyric-stage-panel-theme', theme: appearance },
        '*',
      );
    } catch {
      // host page gone — nothing to restyle
    }
  }
}

const DEBUG_CHROME_KEY = 'lyric-stage:debug-chrome';

function applyDebugChrome(): void {
  document.body.dataset.debug = prefs.debugChrome ? 'true' : 'false';
}

/** Popup owns the debug switch; surfaces follow it live via storage. */
function watchDebugChrome(): void {
  try {
    void chrome.storage.local.get(DEBUG_CHROME_KEY).then((stored) => {
      prefs = { ...prefs, debugChrome: stored[DEBUG_CHROME_KEY] === true };
      applyDebugChrome();
    }).catch(() => {
      // invalidated context (stale iframe after extension reload) — keep off
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !(DEBUG_CHROME_KEY in changes)) return;
      prefs = { ...prefs, debugChrome: changes[DEBUG_CHROME_KEY]?.newValue === true };
      applyDebugChrome();
    });
  } catch {
    // storage unavailable (tests) — default stays off
  }
}

/**
 * Apply display mode / theme / secondary visibility.
 * Prefer source "api" for mode morph so karaoke→lrc keeps paint transition
 * (source "ui" forces settle and causes fill-alpha hard cuts).
 */
function applyPlayerThemeAndMode(
  source: 'api' | 'ui' = 'api',
): { readonly accepted: boolean } | null {
  if (!player) return null;
  const appearance = resolveThemeAppearance(prefs.theme);
  const result = player.setOptions(
    {
      displayMode: effectiveDisplayMode(),
      backgroundAppearance: appearance,
      translationVisible: hasTranslationTrack && prefs.translationVisible,
      pronunciationVisible: hasPronunciationTrack && prefs.pronunciationVisible,
    },
    { source },
  );
  applyPlaintextFollowPolicy();
  return result;
}

/** Tracks whether the player currently has the playback clock attached. */
let playbackFollowState: 'attached' | 'detached' | null = null;

/**
 * Text mode should not auto-follow playback (static poem view). Idempotent:
 * a redundant setPlayback re-bind issues a synchronous 'bind' frame that
 * cancels in-flight secondary-lane animations in the same tick — the reason
 * translation/pronunciation toggles showed no transition.
 */
function applyPlaintextFollowPolicy(): void {
  if (!player) return;
  const desired = effectiveDisplayMode() === 'plaintext' ? 'detached' : 'attached';
  if (desired === playbackFollowState) return;
  playbackFollowState = desired;
  if (desired === 'detached') {
    // Detach playback clock so plaintext stays static; keep commands for click-seek no-ops.
    player.setPlayback(null, commands);
  } else {
    player.setPlayback(offsetBinding.clock, commands);
  }
}

function applyTypographyTiers(): void {
  if (!player) return;
  try {
    player.setLayoutProfile(activeLayoutProfile());
    player.setFontWeightTier(
      isDocumentFullscreen()
        ? prefs.fullscreenFontWeightTier
        : prefs.fontWeightTier,
    );
    player.setPlaintextFontWeightTier(prefs.plaintextFontWeightTier);
    player.syncScroll();
  } catch {
    // ignore if unmounted
  }
}

function applyBackgroundArtwork(transition: 'crossfade' | 'immediate' = 'crossfade'): void {
  if (!player) return;
  const requestId = ++artworkRequestId;
  const run = async (): Promise<void> => {
    if (!player || requestId !== artworkRequestId) return;
    try {
      if (prefs.backgroundMode === 'solid' || !currentCoverUrl) {
        // Always crossfade solid↔cover so scrim/gain layers do not hard-cut.
        await player.setBackgroundArtwork(null, {
          transition: transition === 'immediate' ? 'immediate' : 'crossfade',
        });
        return;
      }
      await player.setBackgroundArtwork(
        {
          kind: 'url',
          url: currentCoverUrl,
          // Apple/NetEase CDNs often omit ACAO; anonymous can fail → solid.
          // Prefer anonymous first (canvas-safe); retry without on failure.
          crossOrigin: 'anonymous',
        },
        { transition: 'crossfade' },
      );
    } catch {
      if (!player || requestId !== artworkRequestId) return;
      if (prefs.backgroundMode === 'cover' && currentCoverUrl) {
        try {
          await player.setBackgroundArtwork(
            { kind: 'url', url: currentCoverUrl },
            { transition: 'crossfade' },
          );
          return;
        } catch {
          // fall through
        }
      }
      try {
        await player.setBackgroundArtwork(null, { transition: 'crossfade' });
      } catch {
        // ignore
      }
    }
  };
  void run();
}

function setCoverUrl(url: string | null | undefined): void {
  const next = typeof url === 'string' && url.trim() ? url.trim() : null;
  if (next === currentCoverUrl) return;
  currentCoverUrl = next;
  if (prefs.backgroundMode === 'cover') {
    applyBackgroundArtwork('crossfade');
  }
}

/**
 * One 字重 control, several stored tiers: 文本 mode edits
 * plaintextFontWeightTier; fullscreen edits the fullscreen pair (viewing
 * distance differs, user-set defaults 4/5); windowed 整行/逐字 edit the
 * shared synced tier. The segmented rows always reflect the values that are
 * currently being APPLIED.
 */
function activeWeightTier(): number {
  if (effectiveDisplayMode() === 'plaintext') return prefs.plaintextFontWeightTier;
  return isDocumentFullscreen()
    ? prefs.fullscreenFontWeightTier
    : prefs.fontWeightTier;
}

function activeLayoutProfile(): SurfaceLayoutProfile {
  return isDocumentFullscreen()
    ? prefs.fullscreenLayoutProfile
    : prefs.layoutProfile;
}

function buildTierButtons(): void {
  if (ui.prefFontWeight && ui.prefFontWeight.childElementCount === 0) {
    for (const tier of FONT_WEIGHT_TIERS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'segment';
      btn.dataset.fontWeightTier = String(tier);
      btn.textContent = String(tier);
      btn.setAttribute('aria-label', `字重档位 ${tier}`);
      btn.addEventListener('click', () => {
        if (!isLyricsFontWeightTier(tier)) return;
        prefs = effectiveDisplayMode() === 'plaintext'
          ? { ...prefs, plaintextFontWeightTier: tier }
          : isDocumentFullscreen()
            ? { ...prefs, fullscreenFontWeightTier: tier }
            : { ...prefs, fontWeightTier: tier };
        persistPrefs();
        applyTypographyTiers();
        syncSettingsUi();
      });
      ui.prefFontWeight.append(btn);
    }
  }
  if (ui.prefLayoutProfile && ui.prefLayoutProfile.childElementCount === 0) {
    for (const profile of LAYOUT_PROFILE_TIERS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'segment';
      btn.dataset.layoutProfile = profile;
      btn.textContent = layoutProfileLabel(profile);
      btn.setAttribute('aria-label', `字号档位 ${layoutProfileLabel(profile)}`);
      btn.addEventListener('click', () => {
        if (!isSurfaceLayoutProfile(profile)) return;
        prefs = isDocumentFullscreen()
          ? { ...prefs, fullscreenLayoutProfile: profile as SurfaceLayoutProfile }
          : { ...prefs, layoutProfile: profile as SurfaceLayoutProfile };
        persistPrefs();
        applyTypographyTiers();
        syncSettingsUi();
      });
      ui.prefLayoutProfile.append(btn);
    }
  }
}

function syncSettingsUi(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-font-weight-tier]').forEach((btn) => {
    btn.classList.toggle(
      'is-on',
      Number(btn.dataset.fontWeightTier) === activeWeightTier(),
    );
  });
  document.querySelectorAll<HTMLButtonElement>('[data-layout-profile]').forEach((btn) => {
    btn.classList.toggle('is-on', btn.dataset.layoutProfile === activeLayoutProfile());
  });
  const effective = effectiveDisplayMode();
  document.querySelectorAll<HTMLButtonElement>('[data-display-mode]').forEach((btn) => {
    btn.classList.toggle('is-on', btn.dataset.displayMode === effective);
    // Degraded intent stays remembered — surface that in the tooltip so the
    // highlight moving off the clicked button is explicable.
    btn.title = btn.dataset.displayMode === prefs.displayMode && effective !== prefs.displayMode
      ? '当前歌词不支持该模式，已临时降级；获取到支持的歌词后自动恢复'
      : '';
  });
  document.querySelectorAll<HTMLButtonElement>('[data-background-mode]').forEach((btn) => {
    btn.classList.toggle('is-on', btn.dataset.backgroundMode === prefs.backgroundMode);
  });
  document.querySelectorAll<HTMLButtonElement>('[data-pref-theme]').forEach((btn) => {
    btn.classList.toggle('is-on', btn.dataset.prefTheme === prefs.theme);
  });
  if (ui.toggleSettings) {
    ui.toggleSettings.setAttribute('aria-pressed', settingsOpen ? 'true' : 'false');
  }

  if (ui.settingsPanel) {
    ui.settingsPanel.hidden = !settingsOpen;
  }
  if (ui.toggleLibrary) {
    ui.toggleLibrary.setAttribute('aria-pressed', libraryOpen ? 'true' : 'false');
  }
  if (ui.libraryPanel) {
    ui.libraryPanel.hidden = !libraryOpen;
  }
  if (ui.toggleOnlineSearch) {
    ui.toggleOnlineSearch.setAttribute('aria-pressed', onlineSearchOpen ? 'true' : 'false');
  }
  if (ui.onlineSearchPanel) {
    ui.onlineSearchPanel.hidden = !onlineSearchOpen;
  }
  syncFullscreenUi();
  syncSecondaryToggleUi();
}

function ensurePlayer(): void {
  if (playerReady || !ui.playerHost) return;
  const appearance = resolveThemeAppearance(prefs.theme);
  player = createLyricsPlayer({
    // Effective, not intent: with no document bound only plaintext renders.
    displayMode: effectiveDisplayMode(),
    backgroundAppearance: appearance,
    translationVisible: prefs.translationVisible,
    pronunciationVisible: prefs.pronunciationVisible,
  });
  player.mount(ui.playerHost);
  applyPlaintextFollowPolicy();
  player.setActive(true);
  try {
    player.setBackgroundPerformanceMode('auto');
  } catch {
    // ignore
  }
  applyTypographyTiers();
  playerReady = true;
  applyChromeTheme();
  applyBackgroundArtwork('immediate');
  wireSecondaryToggles();
  wireSettingsControls();
  syncSettingsUi();
}

function wireSecondaryToggles(): void {
  const toggleTranslation = (): void => {
    if (!hasTranslationTrack) return;
    const previous = prefs;
    prefs = { ...prefs, translationVisible: !prefs.translationVisible };
    // Secondary-only: ui source avoids heavy FLIP on large songs.
    const result = applyPlayerThemeAndMode('ui');
    if (result && !result.accepted) {
      // Cooldown rejection: the player did not change — roll the pref back
      // so the button never lies and the next click toggles from truth.
      prefs = previous;
    } else {
      persistPrefs();
    }
    syncSecondaryToggleUi();
  };
  const togglePronunciation = (): void => {
    if (!hasPronunciationTrack) return;
    const previous = prefs;
    prefs = { ...prefs, pronunciationVisible: !prefs.pronunciationVisible };
    const result = applyPlayerThemeAndMode('ui');
    if (result && !result.accepted) {
      prefs = previous;
    } else {
      persistPrefs();
    }
    syncSecondaryToggleUi();
  };
  ui.toggleTranslation?.addEventListener('click', toggleTranslation);
  ui.togglePronunciation?.addEventListener('click', togglePronunciation);
}

function isDocumentFullscreen(): boolean {
  return Boolean(document.fullscreenElement);
}

async function toggleFullscreen(): Promise<void> {
  try {
    if (isDocumentFullscreen()) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen();
    }
  } catch {
    // User gesture / permission may reject; leave UI as-is.
  }
  syncFullscreenUi();
}

function syncFullscreenUi(): void {
  const on = isDocumentFullscreen();
  if (ui.toggleFullscreen) {
    ui.toggleFullscreen.setAttribute('aria-pressed', on ? 'true' : 'false');
    ui.toggleFullscreen.title = on ? '退出全屏' : '全屏';
  }
}

function wireSettingsControls(): void {
  buildTierButtons();
  wireLibraryControls();
  wireLibraryEditor();
  wireTimingControls();

  const toggleSettingsOpen = (): void => {
    settingsOpen = !settingsOpen;
    if (settingsOpen) { libraryOpen = false; onlineSearchOpen = false; }
    syncSettingsUi();
  };
  ui.toggleSettings?.addEventListener('click', toggleSettingsOpen);
  ui.toggleLibrary?.addEventListener('click', () => {
    libraryOpen = !libraryOpen;
    if (libraryOpen) { settingsOpen = false; onlineSearchOpen = false; }
    syncSettingsUi();
    if (libraryOpen) void refreshLibraryUi();
  });
  ui.toggleOnlineSearch?.addEventListener('click', () => {
    onlineSearchOpen = !onlineSearchOpen;
    if (onlineSearchOpen) { settingsOpen = false; libraryOpen = false; }
    syncSettingsUi();
    if (onlineSearchOpen) wireOnlineSearchUi();
  });

  ui.toggleFullscreen?.addEventListener('click', () => {
    void toggleFullscreen();
  });
  ui.togglePip?.addEventListener('click', () => {
    void toggleDocumentPip();
  });
  // Panel mode: no PiP — the host-delegated implementation was poor and was
  // removed by user request. Standalone still requires the top-level API.
  if (panelMode || !('documentPictureInPicture' in window)) {
    ui.togglePip?.setAttribute('hidden', '');
  }
  document.addEventListener('fullscreenchange', () => {
    syncFullscreenUi();
    // Fullscreen has its own typography pair — swap tiers with the mode.
    applyTypographyTiers();
    syncSettingsUi();
  });

  document.querySelectorAll<HTMLButtonElement>('[data-display-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.displayMode;
      if (!isSurfaceDisplayMode(mode)) return;
      prefs = { ...prefs, displayMode: mode };
      persistPrefs();
      // api source keeps karaoke↔lrc paint morph (no fill-alpha hard cut).
      applyPlayerThemeAndMode('api');
      syncSettingsUi();
    });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-background-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.backgroundMode;
      if (!isSurfaceBackgroundMode(mode)) return;
      prefs = { ...prefs, backgroundMode: mode };
      persistPrefs();
      applyBackgroundArtwork('crossfade');
      syncSettingsUi();
    });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-pref-theme]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const theme = btn.dataset.prefTheme;
      if (!isSurfaceTheme(theme)) return;
      prefs = { ...prefs, theme };
      persistPrefs();
      applyChromeTheme();
      // Theme-only option change can use api for backgroundAppearance crossfade.
      applyPlayerThemeAndMode('api');
      syncSettingsUi();
    });
  });

  try {
    themeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const onSystemTheme = (): void => {
      if (prefs.theme !== 'system') return;
      applyChromeTheme();
      applyPlayerThemeAndMode('api');
    };
    themeMediaQuery.addEventListener('change', onSystemTheme);
  } catch {
    // ignore
  }
}

function syncSecondaryToggleUi(): void {
  {
    const tBtn = ui.toggleTranslation;
    if (tBtn) {
    tBtn.hidden = !hasTranslationTrack;
    tBtn.setAttribute('aria-pressed', prefs.translationVisible ? 'true' : 'false');
    tBtn.classList.toggle('is-on', prefs.translationVisible && hasTranslationTrack);
    tBtn.disabled = !hasTranslationTrack;
    tBtn.title = hasTranslationTrack
      ? (prefs.translationVisible ? '隐藏翻译' : '显示翻译')
      : '当前歌词无翻译';
    }
  }
  {
    const pBtn = ui.togglePronunciation;
    if (pBtn) {
    pBtn.hidden = !hasPronunciationTrack;
    pBtn.setAttribute('aria-pressed', prefs.pronunciationVisible ? 'true' : 'false');
    pBtn.classList.toggle('is-on', prefs.pronunciationVisible && hasPronunciationTrack);
    pBtn.disabled = !hasPronunciationTrack;
    pBtn.title = hasPronunciationTrack
      ? (prefs.pronunciationVisible ? '隐藏发音' : '显示发音')
      : '当前歌词无发音';
    }
  }
}


function applyLyricDocument(doc: LyricDocumentPayloadV1 | null | undefined): void {
  if (!player) return;
  // Explicit clear when switching away from a source that has no cached lyrics.
  if (!doc) {
    if (lyricRevision === 0 && lyricMediaId === null) return;
    lyricRevision = 0;
    lyricMediaId = null;
    hasTranslationTrack = false;
    hasPronunciationTrack = false;
    documentCapabilities = NO_DOCUMENT_CAPABILITIES;
    // Actually unbind the document — resetting counters alone left the old
    // lyrics rendered beneath the translucent empty overlay.
    player.setLyrics(null);
    applyPlayerThemeAndMode('api');
    syncSettingsUi();
    paint();
    return;
  }
  // Revision is per content session/media. Switching sources both start at
  // revision 1 — only same-media revisions are comparable.
  const sameMedia = lyricMediaId === doc.mediaId;
  // A manual library pick pins the document for the current media; pushes
  // for a DIFFERENT media (song change) release the lock.
  if (manualLibraryLock && sameMedia) return;
  if (!sameMedia) manualLibraryLock = false;
  if (sameMedia && doc.revision <= lyricRevision) return;
  // Song change with a stale clock: setLyrics samples playback synchronously,
  // so if the held anchor still belongs to the PREVIOUS media its late
  // position resolves an active line near the new document's end and
  // auto-follow pins the view there ("new song starts at the bottom").
  // Drop the anchor — the new track's anchor re-arms within one heartbeat
  // (~250ms) and media change hard-accepts content time.
  const heldAnchor = clock.getHeld()?.anchor ?? null;
  if (
    !sameMedia
    && lyricMediaId !== null
    && heldAnchor !== null
    && heldAnchor.mediaId === lyricMediaId
  ) {
    clock.applyAnchor(null);
  }
  lyricRevision = doc.revision;
  lyricMediaId = doc.mediaId;
  void syncTimingOffsetForMedia(doc.mediaId);

  const primary = parsePrimaryDocument(doc);
  if (!primary) return;

  const attached = attachSecondaryTracks(primary, doc);
  hasTranslationTrack = attached.hasTranslation;
  hasPronunciationTrack = attached.hasPronunciation;

  // Pure text (no line/word timing) uses the poem-style plaintext layer.
  // Detect before inserting instrumental gaps — gaps only make sense for timed docs.
  const baseCapabilities = deriveLyricDocumentCapabilities(attached.document);
  const pureText =
    doc.format === 'plaintext'
    || !baseCapabilities.hasLineTiming
    || (
      baseCapabilities.timedLineCount === 0
      && baseCapabilities.lineTypeCounts.static
        + baseCapabilities.lineTypeCounts.credit
        >= baseCapabilities.textLineCount
      && baseCapabilities.textLineCount > 0
    );

  documentCapabilities = pureText
    ? NO_DOCUMENT_CAPABILITIES
    : {
      hasKaraoke: baseCapabilities.hasKaraoke,
      hasLineTiming: baseCapabilities.hasLineTiming,
    };

  const withGaps = pureText
    ? attached.document
    : deriveInstrumentalGaps(attached.document).document;
  player.setLyrics(withGaps);

  if (typeof doc.coverUrl === 'string' && doc.coverUrl.trim()) {
    setCoverUrl(doc.coverUrl);
  }
  // User prefs win for display mode; re-apply tiers after setLyrics geometry.
  applyPlayerThemeAndMode('api');
  applyTypographyTiers();
  syncSettingsUi();
  // Clear waiting overlay as soon as lyrics bind, even before the first anchor.
  paint();
}

function sendSeekIntent(targetMs: number): void {
  if (!port) return;
  lastSeekOutcome = 'pending';
  if (ui.seekStatus) ui.seekStatus.textContent = 'seek pending…';
  try {
    port.postMessage(createMessageEnvelopeV1({
      channel: 'playback',
      type: 'seek-intent',
      messageId: crypto.randomUUID(),
      sentAtMs: Date.now(),
      payload: {
        kind: 'seek-intent',
        surfaceId,
        targetMs: Math.max(0, targetMs),
      },
    }));
  } catch {
    port = null;
    lastSeekOutcome = 'rejected';
    if (ui.seekStatus) ui.seekStatus.textContent = '跳转被拒绝';
    if (ui.seekStatus) ui.seekStatus.textContent = 'seek failed (offline)';
  }
}

function acceptAnchor(anchor: SparsePlaybackAnchorV1 | null): void {
  const next = anchor && isSparsePlaybackAnchorV1(anchor) ? anchor : null;
  clock.applyAnchor(next);
  paint();
  scheduleUiLoop();
}

/** Status-bar UI loop: rAF only while playing + visible; idle is 1 Hz. */
const UI_IDLE_INTERVAL_MS = 1_000;
let uiRafHandle: number | null = null;
let uiIdleTimer: number | null = null;
let lastPaintedClockText = '';
/**
 * Dirty-field cache for the HUD: paint() runs on every playback frame
 * (~540 mutations/s measured), but only the clock and age change per frame.
 * Writing unchanged text still invalidates style/layout, so diff every field.
 */
const lastPaintedHud = new Map<string, string>();

function setTextIfChanged(
  key: string,
  element: { textContent: string | null } | null | undefined,
  next: string,
): void {
  if (!element) return;
  if (lastPaintedHud.get(key) === next) return;
  lastPaintedHud.set(key, next);
  element.textContent = next;
}

function clearUiLoop(): void {
  if (uiRafHandle !== null) {
    cancelAnimationFrame(uiRafHandle);
    uiRafHandle = null;
  }
  if (uiIdleTimer !== null) {
    window.clearInterval(uiIdleTimer);
    uiIdleTimer = null;
  }
}

function shouldRunContinuousUiLoop(): boolean {
  if (document.visibilityState === 'hidden') return false;
  const held = clock.getHeld();
  if (!held) return false;
  const projected = projectSparseAnchor(held, performance.now());
  return projected?.state === 'playing';
}

function scheduleUiLoop(): void {
  clearUiLoop();
  if (shouldRunContinuousUiLoop()) {
    const tick = (): void => {
      paint();
      if (!shouldRunContinuousUiLoop()) {
        scheduleUiLoop();
        return;
      }
      uiRafHandle = requestAnimationFrame(tick);
    };
    uiRafHandle = requestAnimationFrame(tick);
    return;
  }
  // Paused / offline / hidden: refresh status occasionally, not every frame.
  paint();
  uiIdleTimer = window.setInterval(() => {
    if (shouldRunContinuousUiLoop()) {
      scheduleUiLoop();
      return;
    }
    paint();
  }, UI_IDLE_INTERVAL_MS);
}

let lastPaintedEmptyState = '';

function paint(): void {
  const held = clock.getHeld();
  const projected = projectSparseAnchor(held, performance.now());
  // Lyrics can arrive before the first sparse-anchor. Never cover player-core
  // with "waiting for session" once a lyric document is bound.
  const hasLyrics = lyricRevision > 0;
  if ((!projected || !held) && !hasLyrics) {
    ui.empty?.removeAttribute('hidden');
    ui.live?.setAttribute('hidden', '');
    if (ui.empty && lastPaintedEmptyState !== 'waiting') {
      lastPaintedEmptyState = 'waiting';
      ui.empty.textContent = '等待播放会话 — 在支持的网站播放音乐或视频后，歌词将显示在这里';
    }
    return;
  }
  if (!hasLyrics) {
    // Session alive but no lyric bound: the old code hid the overlay and
    // left a blank void with no call to action (review finding).
    ui.empty?.removeAttribute('hidden');
    if (ui.empty && lastPaintedEmptyState !== 'no-lyrics') {
      lastPaintedEmptyState = 'no-lyrics';
      ui.empty.innerHTML = `
        <div style="display: flex; flex-direction: column; gap: 8px;">
          <div>未找到匹配歌词</div>
          <div>
            <button type="button" class="empty-link" id="empty-link-library">从歌词库中选取</button>
            或
            <button type="button" class="empty-link" id="empty-link-search">搜索歌词</button>
          </div>
        </div>
      `;

      document.getElementById('empty-link-library')?.addEventListener('click', (e) => {
        e.stopPropagation();
        libraryOpen = true;
        settingsOpen = false;
        onlineSearchOpen = false;
        syncSettingsUi();
        void refreshLibraryUi();
      });

      document.getElementById('empty-link-search')?.addEventListener('click', (e) => {
        e.stopPropagation();
        onlineSearchOpen = true;
        settingsOpen = false;
        libraryOpen = false;
        syncSettingsUi();
        wireOnlineSearchUi();
      });
    }
  } else {
    lastPaintedEmptyState = 'hidden';
    ui.empty?.setAttribute('hidden', '');
  }
  ui.live?.removeAttribute('hidden');
  if (ui.clock) {
    const nextClock = projected ? formatClock(projected.positionMs) : '—';
    // Avoid redundant DOM writes when idle loop re-paints an unchanged clock.
    if (nextClock !== lastPaintedClockText) {
      lastPaintedClockText = nextClock;
      ui.clock.textContent = nextClock;
    }
  }
  setTextIfChanged(
    'state',
    ui.state,
    projected?.state ?? (hasLyrics ? 'lyrics-ready' : 'offline'),
  );
  if (ui.stateDot) {
    const nextDotClass = `dot ${projected?.state ?? 'paused'}`;
    if (lastPaintedHud.get('stateDot') !== nextDotClass) {
      lastPaintedHud.set('stateDot', nextDotClass);
      ui.stateDot.className = nextDotClass;
    }
  }
  setTextIfChanged(
    'media',
    ui.media,
    held?.anchor.mediaId ?? (hasLyrics ? 'lyrics loaded' : '—'),
  );
  setTextIfChanged('session', ui.session, held?.anchor.sessionId ?? '—');
  setTextIfChanged(
    'generation',
    ui.generation,
    held ? String(held.anchor.generation) : '—',
  );
  setTextIfChanged(
    'sequence',
    ui.sequence,
    held ? String(held.anchor.sequence) : '—',
  );
  setTextIfChanged('rate', ui.rate, held ? `${held.anchor.rate.toFixed(2)}×` : '—');
  // Age changes every frame by definition; quantize to 100ms so the debug
  // field updates at 10Hz instead of forcing a write per frame.
  setTextIfChanged(
    'age',
    ui.age,
    projected ? `${Math.round(projected.ageMs / 100) * 100} ms` : '—',
  );
  // seek-status is event-driven (set in the outcome handler); the paint loop
  // must not overwrite it with a stale value.
  void lastSeekOutcome;
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 750);
}

function connect(): void {
  try {
    port?.disconnect();
  } catch {
    // ignore
  }
  try {
    port = chrome.runtime.connect({ name: 'surface' });
  } catch {
    port = null;
    setConnection('离线');
    scheduleReconnect();
    return;
  }
  setConnection('已连接');
  port.onDisconnect.addListener(() => {
    port = null;
    setConnection('连接断开 · 重试中');
    scheduleReconnect();
  });
  port.onMessage.addListener((message: unknown) => {
    const envelope = parseMessageEnvelopeV1(message);
    if (!envelope.ok) return;
    if (envelope.value.channel === 'session') {
      // Source switching lives in the popup now (来源 row removed from
      // settings by user request); session broadcasts are ignored here.
      return;
    }
    const payload = parsePlaybackPayload(envelope.value.payload);
    if (!payload) return;
    if (payload.kind === 'sparse-anchor') {
      acceptAnchor(payload.anchor);
      return;
    }
    if (payload.kind === 'session-snapshot') {
      acceptAnchor(payload.anchor);
      applyLyricDocument(payload.lyricDocument);
      return;
    }
    if (payload.kind === 'lyric-document') {
      applyLyricDocument(payload.document);
      return;
    }
    if (payload.kind === 'lyric-clear') {
      // "Media X has no lyrics" un-renders documents for OTHER media only
      // (the previous track lingering after a song change). A document
      // already bound FOR X — platform push racing the library miss, or a
      // manual library pick — always beats a concurrent lookup failure.
      if (lyricMediaId === payload.mediaId) return;
      applyLyricDocument(null);
      return;
    }
    if (payload.kind === 'media-meta') {
      currentMediaId = payload.meta.mediaId;
      void syncTimingOffsetForMedia(payload.meta.mediaId);
      if (payload.meta.title !== undefined) currentMediaTitle = payload.meta.title;
      if (payload.meta.creators !== undefined) currentMediaCreators = payload.meta.creators;
      if (libraryOpen) void refreshLibraryUi();
      if (lyricMediaId && payload.meta.mediaId !== lyricMediaId) {
        // Ignore cover updates for non-current media.
        return;
      }
      setCoverUrl(payload.meta.coverUrl);
      return;
    }
    if (payload.kind === 'seek-outcome') {
      if (payload.surfaceId !== surfaceId && payload.surfaceId !== 'unknown') return;
      lastSeekOutcome = payload.outcome;
      if (ui.seekStatus) {
        const outcomeText: Record<string, string> = {
          accepted: '已跳转',
          confirmed: '已跳转',
          rejected: '跳转被拒绝',
          timedOut: '跳转超时',
          superseded: '已被新跳转取代',
        };
        const label = outcomeText[payload.outcome] ?? payload.outcome;
        ui.seekStatus.textContent = payload.positionMs === null
          ? label
          : `${label} ${formatClock(payload.positionMs)}`;
      }
    }
  });
  port.postMessage(createMessageEnvelopeV1({
    channel: 'playback',
    type: 'request-snapshot',
    messageId: crypto.randomUUID(),
    sentAtMs: Date.now(),
    payload: { kind: 'session-snapshot', anchor: null },
  }));
}

// Floating chrome reveal: pointer presence is tracked on <html>. Buttons
// blur after pointer interactions so residual focus cannot pin the bar
// visible once the pointer leaves (keyboard :focus-visible still reveals).
document.documentElement.addEventListener('mouseenter', () => {
  document.documentElement.dataset.pointerOver = 'true';
});
document.documentElement.addEventListener('mouseleave', () => {
  delete document.documentElement.dataset.pointerOver;
});
ui.floatChrome?.addEventListener('pointerup', () => {
  window.setTimeout(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && ui.floatChrome?.contains(active)) {
      active.blur();
    }
  }, 0);
});

watchDebugChrome();
ensurePlayer();
connect();
scheduleUiLoop();
document.addEventListener('visibilitychange', () => {
  scheduleUiLoop();
});

window.__extensionSurface = Object.freeze({
  latest: () => clock.getHeld()?.anchor ?? null,
  projected: () => projectSparseAnchor(clock.getHeld(), performance.now()),
  reconnect: () => connect(),
  playerReady: () => playerReady,
  lyricRevision: () => lyricRevision,
  surfaceId: () => surfaceId,
  seek: (targetMs: number) => sendSeekIntent(targetMs),
});

declare global {
  interface Window {
    __extensionSurface: {
      latest: () => SparsePlaybackAnchorV1 | null;
      projected: () => ReturnType<typeof projectSparseAnchor>;
      reconnect: () => void;
      playerReady: () => boolean;
      lyricRevision: () => number;
      surfaceId: () => string;
      seek: (targetMs: number) => void;
    };
  }
}

let toastTimer: number | null = null;

/** Transient confirmation line; role=status makes it screen-reader audible. */
function showLibraryToast(text: string): void {
  const toast = ui.surfaceToast;
  if (!toast) return;
  toast.dataset.interactive = 'false';
  toast.textContent = text;
  toast.dataset.show = 'true';
  if (toastTimer !== null) window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastTimer = null;
    toast.dataset.show = 'false';
  }, 2_600);
}

function showInteractiveToast(html: string, onAction: (action: string) => void): void {
  const toast = ui.surfaceToast;
  if (!toast) return;
  if (toastTimer !== null) { window.clearTimeout(toastTimer); toastTimer = null; }
  toast.innerHTML = html;
  toast.dataset.show = 'true';
  toast.dataset.interactive = 'true';
  toast.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onAction(btn.dataset.action!);
      toast.dataset.show = 'false';
      toast.dataset.interactive = 'false';
      toast.innerHTML = '';
    }, { once: true });
  });
}

/* ---------------------------------------------------------------- library */

function libraryMediaLabel(): string {
  if (!currentMediaTitle && !currentMediaId) return '—';
  const creators = currentMediaCreators.length > 0
    ? ` · ${currentMediaCreators.join(' / ')}`
    : '';
  return `${currentMediaTitle ?? currentMediaId}${creators}`;
}

async function refreshLibraryUi(): Promise<void> {
  if (ui.libraryMedia) ui.libraryMedia.textContent = libraryMediaLabel();
  libraryEntriesCache = await lyricLibrary.list();
  const preference = currentMediaId
    ? await lyricLibrary.getPreference(currentMediaId)
    : null;
  if (ui.libraryIgnore) {
    const ignored = Boolean(preference?.ignored);
    ui.libraryIgnore.setAttribute('aria-pressed', ignored ? 'true' : 'false');
    ui.libraryIgnore.classList.toggle('is-on', ignored);
    ui.libraryIgnore.textContent = ignored ? '已忽略本媒体' : '忽略本媒体';
  }
  const list = ui.libraryList;
  if (!list) return;
  // Rank by match score for the current media so the likely pick is on top.
  const query = normalizeSearchText(ui.librarySearch?.value ?? '');
  const visible = query
    ? libraryEntriesCache.filter((entry) => {
      const haystack = [
        entry.title,
        ...entry.creators,
        ...(entry.titleAliases ?? []),
        ...(entry.creatorAliases ?? []),
      ].map(normalizeSearchText).join(' ');
      return haystack.includes(query);
    })
    : libraryEntriesCache;
  const sorted = [...visible].sort((left, right) => right.updatedAt - left.updatedAt);
  list.textContent = '';
  list.setAttribute('role', 'listbox');
  for (const entry of sorted.slice(0, 50)) {
    const item = document.createElement('li');
    item.dataset.lyricId = entry.id;
    item.setAttribute('role', 'option');
    item.tabIndex = 0;
    const isActive = preference?.lyricId === entry.id;
    if (isActive) item.dataset.active = 'true';
    item.setAttribute('aria-selected', isActive ? 'true' : 'false');
    const title = document.createElement('span');
    title.className = 'lib-title';
    title.textContent = entry.creators.length > 0
      ? `${entry.title} · ${entry.creators.join(' / ')}`
      : entry.title;
    const badge = document.createElement('span');
    badge.className = 'lib-badge';
    badge.textContent = [
      entry.format,
      entry.hasTranslation ? '译' : '',
    ].filter(Boolean).join(' ');
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'lib-action';
    editBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';
    editBtn.title = '编辑';
    editBtn.setAttribute('aria-label', '编辑');
    editBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      openLibraryEditor(entry.id);
    });
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'lib-action is-delete';
    deleteBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
    deleteBtn.title = '删除';
    deleteBtn.setAttribute('aria-label', '删除');
    deleteBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      void (async () => {
        if (deleteBtn.dataset.confirm !== 'true') {
          // Two-step inline confirm — no native dialogs in the surface.
          deleteBtn.dataset.confirm = 'true';
          deleteBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>';
          deleteBtn.title = '确认删除';
          window.setTimeout(() => {
            deleteBtn.dataset.confirm = 'false';
            deleteBtn.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/></svg>';
            deleteBtn.title = '删除';
          }, 3_000);
          return;
        }
        await lyricLibrary.remove(entry.id);
        void refreshLibraryUi();
      })();
    });
    item.append(title, badge, editBtn, deleteBtn);
    item.addEventListener('click', () => {
      void selectLibraryEntry(entry.id);
    });
    item.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      if (event.target !== item) return; // let inner buttons keep their keys
      event.preventDefault();
      void selectLibraryEntry(entry.id);
    });
    list.append(item);
  }
  if (sorted.length === 0) {
    const empty = document.createElement('li');
    empty.textContent = query
      ? '（无匹配结果）'
      : '（歌词库为空 — 在音乐平台播放歌曲会自动收录）';
    list.append(empty);
  }
}

async function selectLibraryEntry(lyricId: string): Promise<void> {
  const record = await lyricLibrary.getRecord(lyricId);
  if (!record || !currentMediaId) return;
  await lyricLibrary.setPreference(currentMediaId, { lyricId });
  // Apply immediately without waiting for a content round-trip.
  const revisionBefore = lyricRevision;
  manualLibraryLock = false;
  applyLyricDocument({
    mediaId: currentMediaId,
    format: record.format,
    text: record.text,
    sourceName: `library:${record.title}`,
    revision: lyricRevision + 1,
    ...(record.translationText ? { translationText: record.translationText } : {}),
    ...(record.pronunciationText ? { pronunciationText: record.pronunciationText } : {}),
    ...(record.coverUrl ? { coverUrl: record.coverUrl } : {}),
  });
  // Lock only when the pick actually rendered — a parse failure must not pin
  // stale lyrics against valid content re-pushes.
  manualLibraryLock = lyricRevision > revisionBefore
    && lyricMediaId === currentMediaId;
  if (manualLibraryLock) showLibraryToast(`正在使用「${record.title}」`);
  void refreshLibraryUi();
}

function wireLibraryControls(): void {
  ui.librarySearch?.addEventListener('input', () => {
    void refreshLibraryUi();
  });
  ui.libraryIgnore?.addEventListener('click', () => {
    void (async () => {
      if (!currentMediaId) return;
      const preference = await lyricLibrary.getPreference(currentMediaId);
      if (preference?.ignored) {
        await lyricLibrary.clearPreference(currentMediaId);
        // Un-ignoring must actively restore lyrics, not wait for the next
        // incidental push (review finding: window stayed blank).
        try {
          chrome.runtime.sendMessage({ kind: 'lyric-stage-wake-sources' });
        } catch {
          // worker asleep — reconnect loop covers it
        }
        showLibraryToast('已取消忽略，正在重新加载歌词…');
      } else {
        await lyricLibrary.setPreference(currentMediaId, { ignored: true });
        manualLibraryLock = false;
        applyLyricDocument(null);
        showLibraryToast('已忽略本媒体 — 再次点击可恢复');
      }
      void refreshLibraryUi();
    })();
  });

  // Cross-context updates (content auto-saves while this panel is open).
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !libraryOpen) return;
      // Only data keys refresh the list — timing offsets and other chrome
      // saves under sibling prefixes must not re-rank/re-render the panel.
      const dataPrefixes = [
        'lyric-library:record:',
        'lyric-library:index',
        'lyric-library:preference:',
      ];
      if (Object.keys(changes).some(
        (key) => dataPrefixes.some((prefix) => key.startsWith(prefix)),
      )) {
        void refreshLibraryUi();
      }
    });
  } catch {
    // storage API unavailable (tests) — panel refresh happens on open.
  }
}

/* ---------------------------------------------------------------- online search */

function renderOnlineSearchEmpty(message: string): void {
  const list = ui.onlineSearchList;
  if (!list) return;
  list.textContent = '';
  const empty = document.createElement('li');
  empty.textContent = message;
  list.append(empty);
}

function wireOnlineSearchUi(): void {
  if (!ui.onlineSearchMedia) return;

  ui.onlineSearchMedia.textContent = libraryMediaLabel();

  if (ui.onlineSearchInput && !ui.onlineSearchInput.value && currentMediaTitle) {
    ui.onlineSearchInput.value = currentMediaTitle + (currentMediaCreators.length > 0 ? ' ' + currentMediaCreators[0] : '');
  }

  // Segment handlers
  const typeSegments = ui.onlineSearchPanel?.querySelectorAll<HTMLButtonElement>('[data-search-type]') || [];
  typeSegments.forEach(btn => {
    btn.addEventListener('click', () => {
      typeSegments.forEach(b => b.classList.remove('is-on'));
      btn.classList.add('is-on');
    });
  });

  const platSegments = ui.onlineSearchPanel?.querySelectorAll<HTMLButtonElement>('[data-search-platform]') || [];
  platSegments.forEach(btn => {
    btn.addEventListener('click', () => {
      platSegments.forEach(b => b.classList.remove('is-on'));
      btn.classList.add('is-on');
    });
  });

  ui.onlineSearchInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      ui.onlineSearchBtn?.click();
    }
  });

  ui.onlineSearchBtn?.addEventListener('click', () => {
    void executeOnlineSearch();
  });
}

async function executeOnlineSearch(): Promise<void> {
  const query = ui.onlineSearchInput?.value.trim();
  if (!query) return;

  const typeBtn = ui.onlineSearchPanel?.querySelector<HTMLButtonElement>('[data-search-type].is-on');
  const platBtn = ui.onlineSearchPanel?.querySelector<HTMLButtonElement>('[data-search-platform].is-on');

  const searchType = (typeBtn?.dataset.searchType || 'song') as SearchType;
  const platform = (platBtn?.dataset.searchPlatform || 'qqmusic') as SearchPlatform;

  if (ui.onlineSearchStatus) ui.onlineSearchStatus.textContent = '搜索中…';
  if (ui.onlineSearchBtn) ui.onlineSearchBtn.disabled = true;
  renderOnlineSearchEmpty('搜索中…');

  try {
    const req: LyricSearchRequest = { query, platform, searchType, limit: 20 };
    const response = await chrome.runtime.sendMessage({
      kind: 'lyric-stage-search-request',
      request: req,
    });

    if (!response || !response.ok) {
      throw new Error(response?.reason || 'Search failed');
    }

    const items = response.items as LyricSearchResultItem[];
    if (items.length === 0) {
      renderOnlineSearchEmpty('未找到相关结果');
    } else {
      renderSearchResults(items);
    }
  } catch (error) {
    renderOnlineSearchEmpty(`搜索出错: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (ui.onlineSearchStatus) ui.onlineSearchStatus.textContent = '';
    if (ui.onlineSearchBtn) ui.onlineSearchBtn.disabled = false;
  }
}

function renderSearchResults(items: LyricSearchResultItem[]): void {
  const list = ui.onlineSearchList;
  if (!list) return;
  list.textContent = '';
  list.setAttribute('role', 'listbox');

  for (const item of items) {
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.tabIndex = 0;

    const title = document.createElement('span');
    title.className = 'lib-title';
    title.textContent = item.artists.length > 0
      ? `${item.title} · ${item.artists.join(' / ')}`
      : item.title;

    const badge = document.createElement('span');
    badge.className = 'lib-badge';
    if (item.album) {
      badge.textContent = item.album;
    } else if (item.snippet) {
      // Snippets often contain HTML tags (like <em> or <b>) from the search API
      const stripped = item.snippet.replace(/<[^>]+>/g, '').substring(0, 15);
      badge.textContent = stripped + '...';
    }

    li.append(title, badge);

    li.addEventListener('click', () => {
      void selectSearchResult(item);
    });
    li.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        void selectSearchResult(item);
      }
    });

    list.append(li);
  }
}

async function selectSearchResult(item: LyricSearchResultItem): Promise<void> {
  if (ui.onlineSearchStatus) ui.onlineSearchStatus.textContent = '获取歌词中…';

  try {
    const response = await chrome.runtime.sendMessage({
      kind: 'lyric-stage-fetch-lyric-request',
      request: { platform: item.platform, externalId: item.externalId },
    });

    if (!response || !response.ok) {
      throw new Error(response?.reason || 'Fetch failed');
    }

    const lyricData = response.lyric as PortableLyricText;

    // Close search panel temporarily to show preview
    onlineSearchOpen = false;
    syncSettingsUi();

    // Preview
    applyLyricDocument({
      mediaId: currentMediaId ?? 'preview',
      format: lyricData.format,
      text: lyricData.text,
      sourceName: `search:${item.title}`,
      revision: lyricRevision + 1,
      ...(lyricData.translationText ? { translationText: lyricData.translationText } : {}),
      ...(lyricData.pronunciationText ? { pronunciationText: lyricData.pronunciationText } : {}),
    });

    // Ask user
    showInteractiveToast(
      '<div>歌词对吗？</div><div class="surface-toast-actions"><button type="button" data-action="yes">是</button><button type="button" data-action="no">否</button></div>',
      (action) => {
        if (action === 'yes') {
          void confirmAndSaveSearchResult(item, lyricData);
        } else {
          // Revert preview and reopen search
          applyLyricDocument(null);
          onlineSearchOpen = true;
          syncSettingsUi();
        }
      }
    );

  } catch (error) {
    showLibraryToast(`获取失败: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (ui.onlineSearchStatus) ui.onlineSearchStatus.textContent = '';
  }
}

async function confirmAndSaveSearchResult(item: LyricSearchResultItem, lyricData: PortableLyricText): Promise<void> {
  if (!currentMediaId) return;
  try {
    const record = await lyricLibrary.upsert({
      title: item.title,
      creators: item.artists,
      format: lyricData.format,
      text: lyricData.text,
      ...(lyricData.translationText ? { translationText: lyricData.translationText } : {}),
      ...(lyricData.pronunciationText ? { pronunciationText: lyricData.pronunciationText } : {}),
    });
    await lyricLibrary.setPreference(currentMediaId, { lyricId: record.id });

    // Lock it so content pushes don't overwrite it
    const revisionBefore = lyricRevision;
    applyLyricDocument({
      mediaId: currentMediaId,
      format: record.format,
      text: record.text,
      sourceName: `library:${record.title}`,
      revision: lyricRevision + 1,
      ...(record.translationText ? { translationText: record.translationText } : {}),
      ...(record.pronunciationText ? { pronunciationText: record.pronunciationText } : {}),
    });
    manualLibraryLock = lyricRevision > revisionBefore && lyricMediaId === currentMediaId;

    showLibraryToast('✓ 已应用歌词');
  } catch (e) {
    showLibraryToast(`保存失败: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/* ----------------------------------------------------------- timing offset */

function formatOffset(offsetMs: number): string {
  const seconds = offsetMs / 1000;
  return `${seconds > 0 ? '+' : ''}${seconds.toFixed(1)}s`;
}

function syncTimingOffsetUi(): void {
  if (ui.timingOffsetValue) {
    ui.timingOffsetValue.textContent = formatOffset(offsetBinding.offsetMs);
  }
  if (ui.timingOffsetGlobal) {
    const on = globalTimingOffsetMs !== null;
    ui.timingOffsetGlobal.setAttribute('aria-pressed', on ? 'true' : 'false');
    ui.timingOffsetGlobal.classList.toggle('is-on', on);
    ui.timingOffsetGlobal.title = on
      ? `本网站默认校准 ${formatOffset(globalTimingOffsetMs ?? 0)}（调整时同步更新）— 点击关闭`
      : '以当前值作为本网站所有歌词的默认校准';
  }
}

/** Loads the persisted offset when the bound media changes; 0 when absent. */
function timingPlatform(): string | null {
  // mediaId format platform:externalId[:contextId]; per-media offsets are
  // keyed by full mediaId (platform-prefixed), so calibration is inherently
  // per-site and never syncs across sites for the same lyric record.
  const source = timingOffsetMediaId ?? '';
  const colon = source.indexOf(':');
  return colon > 0 ? source.slice(0, colon) : null;
}

async function syncTimingOffsetForMedia(mediaId: string): Promise<void> {
  if (timingOffsetMediaId === mediaId) return;
  timingOffsetMediaId = mediaId;
  try {
    const storage = chromeLyricStorage();
    const [stored, global] = await Promise.all([
      loadStoredTimingOffset(storage, mediaId),
      loadGlobalTimingOffset(storage, timingPlatform() ?? ''),
    ]);
    // Media may have changed again while loading.
    if (timingOffsetMediaId !== mediaId) return;
    globalTimingOffsetMs = global;
    // Per-media value always wins; the site global fills the gap for tracks
    // never individually calibrated.
    timingRidesGlobal = stored === null && global !== null;
    offsetBinding.setOffsetMs(stored ?? global ?? 0);
  } catch {
    globalTimingOffsetMs = null;
    timingRidesGlobal = false;
    offsetBinding.setOffsetMs(0);
  }
  syncTimingOffsetUi();
}

function scheduleTimingOffsetSave(): void {
  if (timingSaveTimer !== null) window.clearTimeout(timingSaveTimer);
  const mediaId = timingOffsetMediaId;
  if (!mediaId) return;
  timingSaveTimer = window.setTimeout(() => {
    timingSaveTimer = null;
    // Adjusting counts as calibrating THIS track — even (especially) while
    // the site global is active, and even to an explicit 0 in that case.
    timingRidesGlobal = false;
    const storage = chromeLyricStorage();
    void saveTimingOffset(storage, mediaId, offsetBinding.offsetMs, {
      keepZero: globalTimingOffsetMs !== null,
    }).catch(() => {});
    // While 全局 is active, adjustments also retarget the site default (no
    // deactivate/reactivate dance to change it). Tracks with their own key
    // are unaffected; only riders follow the new global.
    if (globalTimingOffsetMs !== null) {
      globalTimingOffsetMs = offsetBinding.offsetMs;
      const platform = timingPlatform();
      if (platform) {
        void saveGlobalTimingOffset(storage, platform, globalTimingOffsetMs)
          .catch(() => {});
      }
    }
    syncTimingOffsetUi();
  }, 400);
}

function stepTimingOffset(deltaMs: number): void {
  offsetBinding.setOffsetMs(Math.max(
    -TIMING_OFFSET_LIMIT_MS,
    Math.min(TIMING_OFFSET_LIMIT_MS, offsetBinding.offsetMs + deltaMs),
  ));
  syncTimingOffsetUi();
  scheduleTimingOffsetSave();
}

/** Press-and-hold repeats the step (300ms delay, then 10 Hz). */
function wireStepButton(button: HTMLButtonElement | null, deltaMs: number): void {
  if (!button) return;
  let holdTimer: number | null = null;
  let repeatTimer: number | null = null;
  const clear = (): void => {
    if (holdTimer !== null) window.clearTimeout(holdTimer);
    if (repeatTimer !== null) window.clearInterval(repeatTimer);
    holdTimer = null;
    repeatTimer = null;
  };
  button.addEventListener('pointerdown', () => {
    stepTimingOffset(deltaMs);
    holdTimer = window.setTimeout(() => {
      repeatTimer = window.setInterval(() => stepTimingOffset(deltaMs), 100);
    }, 300);
  });
  for (const type of ['pointerup', 'pointerleave', 'pointercancel'] as const) {
    button.addEventListener(type, clear);
  }
  button.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    stepTimingOffset(deltaMs);
  });
}

function wireTimingControls(): void {
  wireStepButton(ui.timingOffsetMinus, -TIMING_STEP_MS);
  wireStepButton(ui.timingOffsetPlus, TIMING_STEP_MS);
  ui.timingOffsetReset?.addEventListener('click', () => {
    // Reset clears THIS track's calibration and returns it to the site
    // global (if active) — deleting the per-media key, not writing 0.
    if (timingSaveTimer !== null) {
      window.clearTimeout(timingSaveTimer);
      timingSaveTimer = null;
    }
    const mediaId = timingOffsetMediaId;
    if (mediaId) {
      void clearTimingOffset(chromeLyricStorage(), mediaId).catch(() => {});
    }
    timingRidesGlobal = globalTimingOffsetMs !== null;
    offsetBinding.setOffsetMs(globalTimingOffsetMs ?? 0);
    syncTimingOffsetUi();
  });
  ui.timingOffsetGlobal?.addEventListener('click', () => {
    void (async () => {
      const platform = timingPlatform();
      if (!platform) return;
      const storage = chromeLyricStorage();
      if (globalTimingOffsetMs === null) {
        // Activate: capture the CURRENTLY SHOWN value as the site default.
        // Does not touch per-media keys, and does not mark this track as
        // individually calibrated (it now rides the global).
        globalTimingOffsetMs = offsetBinding.offsetMs;
        await saveGlobalTimingOffset(storage, platform, globalTimingOffsetMs);
        if (timingOffsetMediaId) {
          const stored = await loadStoredTimingOffset(storage, timingOffsetMediaId);
          timingRidesGlobal = stored === null;
        }
        showLibraryToast(`已将 ${formatOffset(globalTimingOffsetMs)} 设为本网站默认校准`);
      } else {
        // Deactivate: drop the site global; tracks riding it fall back to 0,
        // individually calibrated tracks keep their own values.
        await saveGlobalTimingOffset(storage, platform, null);
        globalTimingOffsetMs = null;
        if (timingRidesGlobal) {
          timingRidesGlobal = false;
          offsetBinding.setOffsetMs(0);
        }
        showLibraryToast('已关闭本网站默认校准');
      }
      syncTimingOffsetUi();
    })();
  });
}

/* ---------------------------------------------------------- library editor */

let editingLyricId: string | null = null;

function openLibraryEditor(lyricId: string): void {
  void (async () => {
    const record = await lyricLibrary.getRecord(lyricId);
    const panel = ui.libraryEditPanel;
    if (!record || !panel) return;
    editingLyricId = lyricId;
    if (ui.libraryEditTitle) ui.libraryEditTitle.value = record.title;
    if (ui.libraryEditCreators) {
      ui.libraryEditCreators.value = record.creators.join(' / ');
    }
    if (ui.libraryEditTitleAliases) {
      ui.libraryEditTitleAliases.value = (record.titleAliases ?? []).join(' / ');
    }
    if (ui.libraryEditCreatorAliases) {
      ui.libraryEditCreatorAliases.value = (record.creatorAliases ?? []).join(' / ');
    }
    if (ui.libraryEditText) ui.libraryEditText.value = record.text;
    if (ui.libraryEditTranslation) {
      ui.libraryEditTranslation.value = record.translationText ?? '';
    }
    if (ui.libraryEditStatus) {
      // Copy-on-edit notice for platform records.
      ui.libraryEditStatus.textContent = record.source
        ? '平台歌词：改动正文将保存为独立副本'
        : '';
    }
    panel.hidden = false;
  })();
}

function splitAliasInput(value: string): string[] {
  return value
    .split(/\s*[/、]\s*/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function wireLibraryEditor(): void {
  ui.libraryEditSave?.addEventListener('click', () => {
    void (async () => {
      if (!editingLyricId) return;
      const record = await lyricLibrary.getRecord(editingLyricId);
      if (!record) return;
      const status = ui.libraryEditStatus;
      const nextText = ui.libraryEditText?.value.trim() ?? '';
      const nextTranslation = ui.libraryEditTranslation?.value.trim() ?? '';
      const textChanged = nextText !== record.text
        || nextTranslation !== (record.translationText ?? '');
      let targetId = editingLyricId;
      if (textChanged) {
        if (!nextText) {
          if (status) status.textContent = '正文不能为空';
          return;
        }
        // Validate with the record's own parser before persisting.
        const probe = parsePrimaryDocument({
          mediaId: 'probe',
          format: record.format,
          text: nextText,
          sourceName: 'edit-probe',
          revision: 1,
        });
        if (!probe || probe.lines.length === 0) {
          if (status) status.textContent = `按 ${record.format} 解析失败，未保存`;
          return;
        }
        try {
          const saved = await lyricLibrary.saveEditedText(editingLyricId, {
            text: nextText,
            ...(nextTranslation ? { translationText: nextTranslation } : {}),
          });
          if (saved) targetId = saved.id;
        } catch (error) {
          if (status) {
            status.textContent = error instanceof Error ? error.message : '保存失败';
          }
          return;
        }
      }
      const nextTitle = ui.libraryEditTitle?.value.trim();
      await lyricLibrary.updateMetadata(targetId, {
        ...(nextTitle && targetId === editingLyricId ? { title: nextTitle } : {}),
        creators: splitAliasInput(ui.libraryEditCreators?.value ?? ''),
        titleAliases: splitAliasInput(ui.libraryEditTitleAliases?.value ?? ''),
        creatorAliases: splitAliasInput(ui.libraryEditCreatorAliases?.value ?? ''),
      });
      // An edited copy becomes this media's explicit selection.
      if (targetId !== editingLyricId && currentMediaId) {
        await lyricLibrary.setPreference(currentMediaId, { lyricId: targetId });
        await selectLibraryEntry(targetId);
      }
      if (ui.libraryEditPanel) ui.libraryEditPanel.hidden = true;
      showLibraryToast(targetId === editingLyricId
        ? '已保存修改'
        : '已保存为独立副本并应用');
      editingLyricId = null;
      void refreshLibraryUi();
    })();
  });
  ui.libraryEditCancel?.addEventListener('click', () => {
    if (ui.libraryEditPanel) ui.libraryEditPanel.hidden = true;
    editingLyricId = null;
  });
}

/* ------------------------------------------------------- document pip */

interface DocumentPictureInPicture {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
  readonly window: Window | null;
}

let pipWindow: Window | null = null;
/** Original slot of #player-host so closing PiP restores it exactly. */
let pipHostPlaceholder: Comment | null = null;

function pipApi(): DocumentPictureInPicture | null {
  return (window as unknown as { documentPictureInPicture?: DocumentPictureInPicture })
    .documentPictureInPicture ?? null;
}

/**
 * Moves the mounted player host into a Document PiP window (always-on-top),
 * mirroring stylesheets so the shadow player and cover background carry over.
 * Closing the PiP (either side) moves the host back into the main layout.
 */
async function toggleDocumentPip(): Promise<void> {
  const api = pipApi();
  if (!api) return;
  if (pipWindow) {
    pipWindow.close();
    return;
  }
  const host = ui.playerHost;
  if (!host) return;
  try {
    pipWindow = await api.requestWindow({ width: 400, height: 560 });
  } catch {
    pipWindow = null;
    return;
  }
  const pipDocument = pipWindow.document;
  // Carry the page styles so panel/cover CSS variables keep applying.
  for (const styleNode of document.querySelectorAll('style, link[rel="stylesheet"]')) {
    pipDocument.head.append(styleNode.cloneNode(true));
  }
  pipDocument.body.style.margin = '0';
  pipDocument.body.dataset.pip = 'true';
  pipHostPlaceholder = document.createComment('player-host-pip');
  host.parentNode?.replaceChild(pipHostPlaceholder, host);
  pipDocument.body.append(host);
  ui.togglePip?.setAttribute('aria-pressed', 'true');
  if (ui.togglePip) ui.togglePip.title = '退出画中画';
  ui.pipPlacard?.removeAttribute('hidden');
  pipWindow.addEventListener('pagehide', () => {
    restorePlayerHostFromPip();
  });
}

function restorePlayerHostFromPip(): void {
  const host = ui.playerHost;
  if (host && pipHostPlaceholder?.parentNode) {
    pipHostPlaceholder.parentNode.replaceChild(host, pipHostPlaceholder);
  }
  pipHostPlaceholder = null;
  pipWindow = null;
  ui.togglePip?.setAttribute('aria-pressed', 'false');
  if (ui.togglePip) ui.togglePip.title = '画中画';
  ui.pipPlacard?.setAttribute('hidden', '');
  // Geometry changed contexts; nudge the player to re-measure.
  paint();
}

/* ------------------------------------------------------------ source row */

