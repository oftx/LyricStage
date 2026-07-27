export const VISUAL_LINE_TOP_TOLERANCE_PX = 2;

export interface KaraokeBindingRectInput {
  readonly bindingId: string;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface KaraokeBindingMaskGeometry {
  readonly bindingId: string;
  readonly lineId: string;
  readonly index: number;
  readonly sourceIndex: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly offset: number;
}

export interface KaraokeMaskLayoutOptions {
  readonly containerLeft?: number;
  readonly containerWidth?: number;
}

export interface KaraokeVisualLineGeometry {
  readonly lineId: string;
  readonly index: number;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly bindings: readonly KaraokeBindingMaskGeometry[];
}

export interface KaraokeMaskLayout {
  readonly lines: readonly KaraokeVisualLineGeometry[];
  getLine(lineId: string): KaraokeVisualLineGeometry | null;
  getBinding(bindingId: string): KaraokeBindingMaskGeometry | null;
  getLineForBinding(bindingId: string): KaraokeVisualLineGeometry | null;
}

interface ValidBindingRect extends KaraokeBindingRectInput {
  readonly sourceIndex: number;
  readonly right: number;
  readonly bottom: number;
}

interface MutableVisualLine {
  readonly anchorTop: number;
  readonly bindings: ValidBindingRect[];
}

interface ContainerGeometry {
  readonly left: number;
  readonly width: number;
}

function asValidRect(
  input: KaraokeBindingRectInput,
  sourceIndex: number,
): ValidBindingRect | null {
  if (
    typeof input.bindingId !== "string" ||
    !Number.isFinite(input.left) ||
    !Number.isFinite(input.top) ||
    !Number.isFinite(input.width) ||
    !Number.isFinite(input.height) ||
    input.width <= 0 ||
    input.height <= 0
  ) {
    return null;
  }

  const right = input.left + input.width;
  const bottom = input.top + input.height;
  if (!Number.isFinite(right) || !Number.isFinite(bottom)) return null;
  return { ...input, sourceIndex, right, bottom };
}

function stableVisualLineId(
  bindings: readonly ValidBindingRect[],
  occurrences: Map<string, number>,
): string {
  const signature = bindings
    .map(({ bindingId }) => encodeURIComponent(bindingId))
    .join("/");
  const baseId = `visual-line:${signature}`;
  const occurrence = (occurrences.get(baseId) ?? 0) + 1;
  occurrences.set(baseId, occurrence);
  return occurrence === 1 ? baseId : `${baseId}#${occurrence}`;
}

function resolveContainerGeometry(
  options: KaraokeMaskLayoutOptions,
): ContainerGeometry | null {
  const left = options.containerLeft;
  const width = options.containerWidth;
  if (
    left === undefined ||
    width === undefined ||
    !Number.isFinite(left) ||
    !Number.isFinite(width) ||
    width <= 0 ||
    !Number.isFinite(left + width)
  ) {
    return null;
  }
  return Object.freeze({ left, width });
}

/** Groups ordered, layout-space binding boxes without reading browser state. */
export function createKaraokeMaskLayout(
  inputs: readonly KaraokeBindingRectInput[],
  options: KaraokeMaskLayoutOptions = {},
): KaraokeMaskLayout {
  const groups: MutableVisualLine[] = [];
  const container = resolveContainerGeometry(options);

  inputs.forEach((input, sourceIndex) => {
    const binding = asValidRect(input, sourceIndex);
    if (!binding) return;
    const current = groups[groups.length - 1];
    if (
      current &&
      Math.abs(binding.top - current.anchorTop) <=
        VISUAL_LINE_TOP_TOLERANCE_PX
    ) {
      current.bindings.push(binding);
      return;
    }
    groups.push({ anchorTop: binding.top, bindings: [binding] });
  });

  const lineIdOccurrences = new Map<string, number>();
  const lines = Object.freeze(
    groups.map((group, index): KaraokeVisualLineGeometry => {
      const bindingLeft = Math.min(
        ...group.bindings.map((binding) => binding.left),
      );
      const top = Math.min(...group.bindings.map((binding) => binding.top));
      const bindingRight = Math.max(
        ...group.bindings.map((binding) => binding.right),
      );
      const bottom = Math.max(
        ...group.bindings.map((binding) => binding.bottom),
      );
      const left = container?.left ?? bindingLeft;
      const width = container?.width ?? bindingRight - bindingLeft;
      const lineId = stableVisualLineId(
        group.bindings,
        lineIdOccurrences,
      );
      const bindings = Object.freeze(
        group.bindings.map(
          (binding, bindingIndex): KaraokeBindingMaskGeometry =>
            Object.freeze({
              bindingId: binding.bindingId,
              lineId,
              index: bindingIndex,
              sourceIndex: binding.sourceIndex,
              left: binding.left,
              top: binding.top,
              width: binding.width,
              height: binding.height,
              offset: binding.left - left,
            }),
        ),
      );
      return Object.freeze({
        lineId,
        index,
        left,
        top,
        width,
        height: bottom - top,
        bindings,
      });
    }),
  );

  const linesById = new Map(
    lines.map((line) => [line.lineId, line] as const),
  );
  const bindingsById = new Map<string, KaraokeBindingMaskGeometry>();
  const linesByBindingId = new Map<string, KaraokeVisualLineGeometry>();
  for (const line of lines) {
    for (const binding of line.bindings) {
      if (bindingsById.has(binding.bindingId)) continue;
      bindingsById.set(binding.bindingId, binding);
      linesByBindingId.set(binding.bindingId, line);
    }
  }

  return Object.freeze({
    lines,
    getLine(lineId: string): KaraokeVisualLineGeometry | null {
      return linesById.get(lineId) ?? null;
    },
    getBinding(bindingId: string): KaraokeBindingMaskGeometry | null {
      return bindingsById.get(bindingId) ?? null;
    },
    getLineForBinding(bindingId: string): KaraokeVisualLineGeometry | null {
      return linesByBindingId.get(bindingId) ?? null;
    },
  });
}
