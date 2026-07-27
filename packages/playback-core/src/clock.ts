export interface MonotonicClock {
  now(): number;
}

/** Deterministic clock for fixtures and state-machine tests. */
export class ManualMonotonicClock implements MonotonicClock {
  #nowMs: number;

  constructor(initialNowMs = 0) {
    assertMonotonicTime(initialNowMs, 'initialNowMs');
    this.#nowMs = initialNowMs;
  }

  public now(): number {
    return this.#nowMs;
  }

  public advanceBy(deltaMs: number): number {
    if (!Number.isFinite(deltaMs) || deltaMs < 0) {
      throw new RangeError('deltaMs must be a finite non-negative number');
    }
    this.#nowMs += deltaMs;
    return this.#nowMs;
  }

  public advanceTo(nowMs: number): number {
    assertMonotonicTime(nowMs, 'nowMs');
    if (nowMs < this.#nowMs) {
      throw new RangeError('manual clock cannot move backwards');
    }
    this.#nowMs = nowMs;
    return this.#nowMs;
  }
}

export function assertMonotonicTime(value: number, label = 'time'): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite non-negative number`);
  }
}
