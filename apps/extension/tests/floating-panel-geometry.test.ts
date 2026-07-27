import { describe, expect, it } from 'vitest';
import {
  PANEL_HEIGHT_PX,
  resolveGeometry,
  type PanelLayout,
} from '../src/content/floating-panel.js';

function layout(overrides: Partial<PanelLayout> = {}): PanelLayout {
  return {
    x: 100,
    y: 120,
    width: 360,
    height: PANEL_HEIGHT_PX,
    open: true,
    dockRightPx: null,
    ...overrides,
  };
}

describe('floating panel geometry', () => {
  it('never renders past the bottom edge', () => {
    const g = resolveGeometry(layout({ y: 5_000 }), 1400, 900);
    expect(g.y + g.renderHeight).toBeLessThanOrEqual(900 - 8);
  });

  it('never teleports a left-dragged panel to the right', () => {
    // Regression: the old clamp used x<0 as a "dock right" sentinel, so
    // dragging to the far left (clamped x could go negative transiently)
    // teleported the panel to the right edge.
    const g = resolveGeometry(layout({ x: -300 }), 1400, 900);
    expect(g.x).toBe(8);
  });

  it('shrinks render height on short viewports without touching the stored height', () => {
    const stored = layout();
    const short = resolveGeometry(stored, 1400, 500);
    expect(short.renderHeight).toBeLessThanOrEqual(500 - 16);
    // Stored intent unchanged → a tall viewport restores the full height.
    const tall = resolveGeometry(stored, 1400, 1200);
    expect(tall.renderHeight).toBe(PANEL_HEIGHT_PX);
  });

  it('docked panel follows the right edge across viewport resizes', () => {
    const docked = layout({ dockRightPx: 16 });
    const wide = resolveGeometry(docked, 1600, 900);
    expect(wide.x).toBe(1600 - wide.width - 16);
    const narrow = resolveGeometry(docked, 800, 900);
    expect(narrow.x).toBe(800 - narrow.width - 16);
    // Regression: shrink then grow must return to the right edge, not stick
    // at the narrow position.
    const grown = resolveGeometry(docked, 1600, 900);
    expect(grown.x).toBe(1600 - grown.width - 16);
  });

  it('free-floating panel keeps its position but stays inside the viewport', () => {
    const free = layout({ x: 200, dockRightPx: null });
    expect(resolveGeometry(free, 1600, 900).x).toBe(200);
    // Off-right after a shrink: clamped visually, intent preserved by caller.
    const clamped = resolveGeometry(layout({ x: 1500, dockRightPx: null }), 800, 900);
    expect(clamped.x).toBe(800 - clamped.width - 8);
  });
});
