/**
 * Minimal in-memory chrome.* mock for unit tests.
 *
 * Covers exactly the API surface the extension uses (see grep over src/):
 * runtime connect/messaging, tabs query/sendMessage, scripting.executeScript,
 * windows create/get/update. Handlers are plain arrays the test drives
 * directly; no timers, no async queues beyond microtasks.
 *
 * Usage:
 *   const mock = createChromeMock();
 *   installChromeMock(mock);          // sets globalThis.chrome
 *   await import('../src/background/wake.js');
 */

type Listener = (...args: unknown[]) => unknown;

export interface MockPort {
  readonly name: string;
  readonly sender: { tab?: { id: number } } | undefined;
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(fn: Listener): void; removeListener(fn: Listener): void };
  onDisconnect: { addListener(fn: Listener): void; removeListener(fn: Listener): void };
  /** Test-side: messages the code under test posted through this port. */
  readonly sent: unknown[];
  /** Test-side: deliver a message to the code under test. */
  emitMessage(message: unknown): void;
  /** Test-side: fire disconnect listeners. */
  emitDisconnect(): void;
}

export interface ChromeMock {
  readonly chrome: Record<string, unknown>;
  /** Ports created via chrome.runtime.connect, in creation order. */
  readonly connectedPorts: MockPort[];
  /** Fire chrome.runtime.onConnect with a new mock port; returns it. */
  connectIncomingPort(name: string, tabId?: number): MockPort;
  /** Fire chrome.runtime.onMessage; returns collected sendResponse values. */
  emitRuntimeMessage(message: unknown, sender?: unknown): unknown[];
  /** Test-side control of tabs.query results. */
  setTabs(tabs: Array<{ id: number; url: string }>): void;
  /** Calls recorded against tabs.sendMessage / scripting.executeScript. */
  readonly tabMessages: Array<{ tabId: number; message: unknown }>;
  readonly injections: Array<{ tabId: number; files: readonly string[] }>;
  /** Per-tab responders for tabs.sendMessage; absent → reject like a dead tab. */
  respondToTabMessage(tabId: number, responder: (message: unknown) => unknown): void;
}

function createEvent(): { addListener(fn: Listener): void; removeListener(fn: Listener): void; listeners: Listener[] } {
  const listeners: Listener[] = [];
  return {
    listeners,
    addListener(fn: Listener) { listeners.push(fn); },
    removeListener(fn: Listener) {
      const index = listeners.indexOf(fn);
      if (index >= 0) listeners.splice(index, 1);
    },
  };
}

function createMockPort(name: string, tabId?: number): MockPort {
  const onMessage = createEvent();
  const onDisconnect = createEvent();
  const sent: unknown[] = [];
  let disconnected = false;
  return {
    name,
    sender: tabId === undefined ? undefined : { tab: { id: tabId } },
    sent,
    postMessage(message: unknown) {
      if (disconnected) throw new Error('Attempting to use a disconnected port object');
      sent.push(message);
    },
    disconnect() {
      if (disconnected) return;
      disconnected = true;
      for (const fn of [...onDisconnect.listeners]) fn(this);
    },
    onMessage,
    onDisconnect,
    emitMessage(message: unknown) {
      for (const fn of [...onMessage.listeners]) fn(message, this);
    },
    emitDisconnect() {
      if (disconnected) return;
      disconnected = true;
      for (const fn of [...onDisconnect.listeners]) fn(this);
    },
  };
}

export function createChromeMock(): ChromeMock {
  const onConnect = createEvent();
  const onRuntimeMessage = createEvent();
  const connectedPorts: MockPort[] = [];
  const tabMessages: Array<{ tabId: number; message: unknown }> = [];
  const injections: Array<{ tabId: number; files: readonly string[] }> = [];
  const tabResponders = new Map<number, (message: unknown) => unknown>();
  let tabs: Array<{ id: number; url: string }> = [];

  const chrome = {
    runtime: {
      id: 'mock-extension-id',
      lastError: undefined as { message: string } | undefined,
      getURL: (path: string) => `chrome-extension://mock-extension-id/${path.replace(/^\//, '')}`,
      connect: (options?: { name?: string }) => {
        const port = createMockPort(options?.name ?? '');
        connectedPorts.push(port);
        return port;
      },
      sendMessage: (message: unknown, callback?: (response: unknown) => void) => {
        const responses: unknown[] = [];
        for (const fn of [...onRuntimeMessage.listeners]) {
          fn(message, { id: 'mock-extension-id' }, (response: unknown) => { responses.push(response); });
        }
        if (callback) queueMicrotask(() => callback(responses[0]));
        return Promise.resolve(responses[0]);
      },
      onConnect,
      onMessage: onRuntimeMessage,
    },
    tabs: {
      query: (_query: unknown) => Promise.resolve(tabs.map((tab) => ({ ...tab }))),
      sendMessage: (tabId: number, message: unknown) => {
        tabMessages.push({ tabId, message });
        const responder = tabResponders.get(tabId);
        if (!responder) return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
        try {
          return Promise.resolve(responder(message));
        } catch (error) {
          return Promise.reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
    },
    scripting: {
      executeScript: (options: { target: { tabId: number }; files: readonly string[] }) => {
        injections.push({ tabId: options.target.tabId, files: options.files });
        return Promise.resolve([]);
      },
    },
    windows: {
      create: (options: unknown) => Promise.resolve({ id: 9001, ...(options as object) }),
      get: (_id: number) => Promise.resolve({ id: 9001 }),
      update: (_id: number, _info: unknown) => Promise.resolve({ id: 9001 }),
      onRemoved: createEvent(),
    },
  };

  return {
    chrome,
    connectedPorts,
    connectIncomingPort(name: string, tabId?: number) {
      const port = createMockPort(name, tabId);
      for (const fn of [...onConnect.listeners]) fn(port);
      return port;
    },
    emitRuntimeMessage(message: unknown, sender: unknown = { id: 'mock-extension-id' }) {
      const responses: unknown[] = [];
      for (const fn of [...onRuntimeMessage.listeners]) {
        fn(message, sender, (response: unknown) => { responses.push(response); });
      }
      return responses;
    },
    setTabs(next: Array<{ id: number; url: string }>) { tabs = next; },
    tabMessages,
    injections,
    respondToTabMessage(tabId: number, responder: (message: unknown) => unknown) {
      tabResponders.set(tabId, responder);
    },
  };
}

export function installChromeMock(mock: ChromeMock): void {
  (globalThis as Record<string, unknown>).chrome = mock.chrome;
}

export function uninstallChromeMock(): void {
  delete (globalThis as Record<string, unknown>).chrome;
}
