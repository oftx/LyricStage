export type Disposer = () => void;

const noop = (): void => {};

export class DisposableScope {
  readonly #disposers: Disposer[] = [];
  #disposed = false;

  get disposed(): boolean {
    return this.#disposed;
  }

  add(disposer: Disposer): Disposer {
    if (this.#disposed) {
      disposer();
      return noop;
    }

    let active = true;
    const wrapped = (): void => {
      if (!active) return;
      active = false;
      const index = this.#disposers.indexOf(wrapped);
      if (index >= 0) this.#disposers.splice(index, 1);
      disposer();
    };
    this.#disposers.push(wrapped);
    return wrapped;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;

    const pending = this.#disposers.splice(0).reverse();
    const errors: unknown[] = [];
    for (const dispose of pending) {
      try {
        dispose();
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "Multiple resources failed to dispose");
    }
  }
}
