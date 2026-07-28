/**
 * In-page floating lyric panel, the userscript's primary presentation form.
 *
 * Structure: a closed shadow host fixed to the viewport containing an edge
 * entry button and a draggable glass panel that embeds the extension surface
 * (surface.html?panel=1) in an iframe — the surface already owns the player,
 * library, offsets, and worker port, so the panel is pure chrome: position,
 * visibility, drag, and persistence. Layout persists per origin in
 * chrome.storage.local.
 */

/** UI chrome namespace — deliberately outside lyric-library: so panel saves
 * never trigger the surfaces' library-data storage listeners. */
const PANEL_STATE_KEY = 'lyric-panel:';
/** Popup option: explicit false hides the edge handle on supported pages. */
const PANEL_HANDLE_KEY = 'lyric-stage:panel-handle';

export interface PanelLayout {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly open: boolean;
  /**
   * Docked to the viewport's right edge with this gap (px), or null when
   * free-floating. A dock survives viewport resizes — the panel follows the
   * edge — and is set/cleared only at drag/resize end, so it never fights
   * pointer-driven movement.
   */
  readonly dockRightPx: number | null;
}

/** Old default was 520; bumped 1.5x by request. Old persisted 520 migrates. */
export const PANEL_HEIGHT_PX = 780;
const LEGACY_PANEL_HEIGHT_PX = 520;
/** Drop the panel this close to the right edge and it docks there. */
const EDGE_DOCK_THRESHOLD_PX = 24;

const DEFAULT_LAYOUT: PanelLayout = {
  x: 0,
  y: 120,
  width: 360,
  height: PANEL_HEIGHT_PX,
  open: false,
  dockRightPx: 16,
};

export interface ResolvedPanelGeometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  /** May be smaller than layout.height on short viewports; the stored
   * height constant is never overwritten, so a taller viewport restores it. */
  readonly renderHeight: number;
}

/**
 * Layout holds USER INTENT and is persisted as-is; clamping happens only at
 * render time. Writing clamped values back (the old behavior) destroyed the
 * intent: shrinking the page permanently pushed a right-edge panel left, and
 * growing it back never restored the position.
 */
export function resolveGeometry(
  layout: PanelLayout,
  viewportW: number,
  viewportH: number,
): ResolvedPanelGeometry {
  const width = Math.min(Math.max(280, layout.width), Math.max(280, viewportW - 24));
  const renderHeight = Math.min(
    Math.max(320, layout.height),
    Math.max(240, viewportH - 16),
  );
  const wanted = layout.dockRightPx !== null
    ? viewportW - width - layout.dockRightPx
    : layout.x;
  const x = Math.min(Math.max(8, wanted), Math.max(8, viewportW - width - 8));
  // Hard bottom constraint: the panel may never extend past the page bottom.
  const y = Math.min(Math.max(8, layout.y), Math.max(8, viewportH - renderHeight - 8));
  return { x, y, width, renderHeight };
}

export interface FloatingPanelController {
  destroy(): void;
  setVisibility(visible: boolean): void;
}

export function createFloatingLyricPanel(options: {
  readonly surfaceUrl: string;
  readonly storageKeySuffix: string;
}): FloatingPanelController {
  const stateKey = PANEL_STATE_KEY + options.storageKeySuffix;
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483646;';
  // Closed root: host page scripts cannot reach panel internals (userscript rule).
  const root = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .entry {
      position: fixed; right: 0; top: 40vh; pointer-events: auto;
      width: 26px; height: 48px; border: 0; cursor: pointer;
      border-radius: 8px 0 0 8px; opacity: 0.55; transition: opacity 0.2s;
      background: rgba(30, 30, 40, 0.85); color: #fff; padding: 0;
      display: grid; place-items: center;
    }
    .entry:hover, .entry:focus-visible { opacity: 1; }
    .entry:focus-visible { outline: 2px solid #4c8bf5; }
    .panel {
      position: fixed; pointer-events: auto; display: none;
      border-radius: 12px; overflow: hidden;
      background: rgba(24, 24, 32, 0.55);
      backdrop-filter: blur(18px) saturate(1.2);
      -webkit-backdrop-filter: blur(18px) saturate(1.2);
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.35);
    }
    .panel[data-open="true"] { display: block; }
    /* The grip OVERLAYS the iframe's top edge instead of stacking above it,
       so hiding it does not change the panel's height. Hidden until the
       pointer is over the panel — immersive lyrics by default. */
    .grip {
      position: absolute; top: 0; left: 0; right: 0; height: 26px;
      z-index: 2; cursor: grab; display: flex;
      align-items: center; justify-content: space-between; padding: 0 8px;
      color: rgba(255, 255, 255, 0.78); font: 12px system-ui;
      background: rgba(10, 10, 16, 0.55);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      user-select: none;
      opacity: 0; transform: translateY(-100%); pointer-events: none;
      transition: opacity 0.22s ease, transform 0.22s ease;
    }
    .panel:hover .grip,
    .grip:focus-within {
      opacity: 1; transform: none; pointer-events: auto;
    }
    .panel[data-grip-theme="light"] .grip {
      color: rgba(30, 33, 38, 0.85);
      background: rgba(255, 255, 255, 0.65);
    }
    .grip:active { cursor: grabbing; }
    .grip button {
      border: 0; background: transparent; color: inherit; cursor: pointer;
      font: inherit; padding: 2px 6px; border-radius: 4px;
    }
    .grip button:hover { background: rgba(255, 255, 255, 0.15); }
    .panel[data-grip-theme="light"] .grip button:hover {
      background: rgba(0, 0, 0, 0.1);
    }
    iframe {
      border: 0; width: 100%; height: 100%; display: block;
      background: transparent;
    }
    .resize {
      position: absolute; right: 0; bottom: 0; width: 16px; height: 16px;
      cursor: nwse-resize; pointer-events: auto;
    }
  `;
  root.append(style);

  const entry = document.createElement('button');
  entry.className = 'entry';
  entry.type = 'button';
  // Quaver icon (userscript-style) instead of vertical text.
  entry.innerHTML =
    '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" '
    + 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" '
    + 'stroke-linejoin="round"><path d="M9 18V5l12-2v13"/>'
    + '<circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>';
  entry.setAttribute('aria-label', 'LyricStage 歌词面板');
  entry.title = 'LyricStage 歌词面板';

  const panel = document.createElement('div');
  panel.className = 'panel';
  const grip = document.createElement('div');
  grip.className = 'grip';
  const gripTitle = document.createElement('span');
  gripTitle.textContent = 'LyricStage';
  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.textContent = '×';
  closeButton.title = '收起面板';
  closeButton.setAttribute('aria-label', '收起歌词面板');
  grip.append(gripTitle, closeButton);
  const frame = document.createElement('iframe');
  frame.allow = 'autoplay; fullscreen';
  const resize = document.createElement('div');
  resize.className = 'resize';
  resize.setAttribute('role', 'separator');
  resize.setAttribute('aria-label', '调整面板大小');
  panel.append(grip, frame, resize);
  root.append(entry, panel);

  let layout = { ...DEFAULT_LAYOUT };
  let frameLoaded = false;

  function currentGeometry(): ResolvedPanelGeometry {
    return resolveGeometry(layout, window.innerWidth, window.innerHeight);
  }

  function applyLayout(): void {
    const geometry = currentGeometry();
    panel.style.left = `${geometry.x}px`;
    panel.style.top = `${geometry.y}px`;
    panel.style.width = `${geometry.width}px`;
    panel.style.height = `${geometry.renderHeight}px`;
    panel.dataset.open = String(layout.open);
    entry.style.display = layout.open ? 'none' : '';
    if (layout.open && !frameLoaded) {
      // Lazy-load: the surface player only spins up when first opened.
      frame.src = options.surfaceUrl;
      frameLoaded = true;
    }
  }

  /** At drag/resize end: dock to the right edge when dropped close to it. */
  function settleDockState(): void {
    const geometry = currentGeometry();
    const gap = window.innerWidth - (geometry.x + geometry.width);
    layout = {
      ...layout,
      // Materialize the rendered position as the new intent…
      x: geometry.x,
      y: geometry.y,
      // …and dock when the right gap is small enough.
      dockRightPx: gap <= EDGE_DOCK_THRESHOLD_PX ? Math.max(0, gap) : null,
    };
  }

  let saveTimer: number | null = null;
  function scheduleSave(): void {
    if (saveTimer !== null) window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      saveTimer = null;
      try {
        void chrome.storage.local.set({ [stateKey]: layout });
      } catch {
        // context invalidated — layout persistence is best-effort
      }
    }, 300);
  }

  entry.addEventListener('click', () => {
    layout = { ...layout, open: true };
    applyLayout();
    scheduleSave();
  });
  closeButton.addEventListener('click', () => {
    layout = { ...layout, open: false };
    applyLayout();
    scheduleSave();
  });

  // Drag via the grip; pointer capture keeps the drag over the iframe.
  grip.addEventListener('pointerdown', (event) => {
    if (event.target === closeButton) return;
    // Undock and adopt the rendered position so the panel tracks the pointer
    // from where it visually is (a docked panel's stored x may be stale).
    const geometry = currentGeometry();
    layout = { ...layout, x: geometry.x, y: geometry.y, dockRightPx: null };
    const startX = event.clientX - layout.x;
    const startY = event.clientY - layout.y;
    grip.setPointerCapture(event.pointerId);
    const onMove = (move: PointerEvent): void => {
      layout = { ...layout, x: move.clientX - startX, y: move.clientY - startY };
      applyLayout();
    };
    const onUp = (): void => {
      grip.removeEventListener('pointermove', onMove);
      grip.removeEventListener('pointerup', onUp);
      settleDockState();
      applyLayout();
      scheduleSave();
    };
    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', onUp);
  });

  resize.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    const geometry = currentGeometry();
    layout = { ...layout, x: geometry.x, y: geometry.y, dockRightPx: null };
    const startW = geometry.width - event.clientX;
    const startH = geometry.renderHeight - event.clientY;
    resize.setPointerCapture(event.pointerId);
    const onMove = (move: PointerEvent): void => {
      layout = { ...layout, width: startW + move.clientX, height: startH + move.clientY };
      applyLayout();
    };
    const onUp = (): void => {
      resize.removeEventListener('pointermove', onMove);
      resize.removeEventListener('pointerup', onUp);
      settleDockState();
      applyLayout();
      scheduleSave();
    };
    resize.addEventListener('pointermove', onMove);
    resize.addEventListener('pointerup', onUp);
  });

  const onViewportResize = (): void => applyLayout();
  window.addEventListener('resize', onViewportResize);

  // Popup-controlled handle visibility. Hiding the handle does not close an
  // OPEN panel (that would yank lyrics mid-song); it only removes the entry.
  let handleEnabled = true;
  function applyHandleVisibility(): void {
    entry.style.visibility = handleEnabled ? '' : 'hidden';
  }
  try {
    void chrome.storage.local.get(PANEL_HANDLE_KEY).then((stored) => {
      handleEnabled = stored[PANEL_HANDLE_KEY] !== false;
      applyHandleVisibility();
    }).catch(() => {
      // invalidated context — handle stays visible
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !(PANEL_HANDLE_KEY in changes)) return;
      handleEnabled = changes[PANEL_HANDLE_KEY]?.newValue !== false;
      applyHandleVisibility();
    });
  } catch {
    // storage unavailable — handle stays visible
  }

  // The embedded surface reports its resolved theme so the grip matches it.
  const onThemeMessage = (event: MessageEvent): void => {
    if (event.source !== frame.contentWindow) return;
    const data = event.data as { kind?: unknown; theme?: unknown } | null;
    if (!data || data.kind !== 'lyric-stage-panel-theme') return;
    panel.dataset.gripTheme = data.theme === 'light' ? 'light' : 'dark';
  };
  window.addEventListener('message', onThemeMessage);

  document.documentElement.append(host);
  applyLayout();
  // Restore persisted layout (open state included) asynchronously.
  try {
    void chrome.storage.local.get(stateKey).then((stored) => {
      const raw = stored[stateKey] as Partial<PanelLayout> | undefined;
      if (!raw || typeof raw !== 'object') return;
      // Validate every field — never spread unchecked storage into layout.
      const storedHeight = typeof raw.height === 'number' && Number.isFinite(raw.height)
        ? raw.height
        : DEFAULT_LAYOUT.height;
      const storedX = typeof raw.x === 'number' && Number.isFinite(raw.x)
        ? raw.x
        : DEFAULT_LAYOUT.x;
      layout = {
        x: Math.max(0, storedX),
        y: typeof raw.y === 'number' && Number.isFinite(raw.y) ? raw.y : DEFAULT_LAYOUT.y,
        width: typeof raw.width === 'number' && Number.isFinite(raw.width)
          ? raw.width
          : DEFAULT_LAYOUT.width,
        // Old default height migrates to the new default; explicit user
        // resizes (any other value) are kept.
        height: storedHeight === LEGACY_PANEL_HEIGHT_PX ? PANEL_HEIGHT_PX : storedHeight,
        open: raw.open === true,
        dockRightPx: typeof raw.dockRightPx === 'number'
          && Number.isFinite(raw.dockRightPx)
          && raw.dockRightPx >= 0
          ? raw.dockRightPx
          // Legacy sentinel: x < 0 meant "right-docked default".
          : storedX < 0 ? 16 : null,
      };
      applyLayout();
    }).catch(() => {
      // invalidated context — defaults stand
    });
  } catch {
    // storage unavailable — defaults stand
  }

  return {
    destroy(): void {
      window.removeEventListener('resize', onViewportResize);
      window.removeEventListener('message', onThemeMessage);
      host.remove();
    },
    setVisibility(visible: boolean): void {
      host.style.display = visible ? '' : 'none';
    },
  };
}
