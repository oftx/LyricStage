// @vitest-environment jsdom
/**
 * Scaffolding sanity: proves per-file jsdom environment and the chrome mock
 * work together, so later page-clock / bridge / worker tests can rely on them.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createChromeMock, installChromeMock, uninstallChromeMock } from './helpers/chrome-mock.js';

describe('test scaffolding', () => {
  afterEach(() => {
    uninstallChromeMock();
  });

  it('provides a jsdom window with postMessage round-trip', async () => {
    expect(typeof window).toBe('object');
    expect(typeof document.querySelector).toBe('function');
    const received: unknown[] = [];
    const onMessage = (event: MessageEvent<unknown>): void => { received.push(event.data); };
    window.addEventListener('message', onMessage);
    window.postMessage({ ping: 1 }, '*');
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    window.removeEventListener('message', onMessage);
    expect(received).toEqual([{ ping: 1 }]);
  });

  it('chrome mock: runtime message reaches listeners and collects responses', () => {
    const mock = createChromeMock();
    installChromeMock(mock);
    const chromeGlobal = (globalThis as Record<string, unknown>).chrome as typeof mock.chrome;
    const runtime = chromeGlobal.runtime as {
      onMessage: { addListener(fn: (message: unknown, sender: unknown, sendResponse: (r: unknown) => void) => void): void };
    };
    runtime.onMessage.addListener((message, _sender, sendResponse) => {
      sendResponse({ echoed: message });
    });
    const responses = mock.emitRuntimeMessage({ kind: 'test' });
    expect(responses).toEqual([{ echoed: { kind: 'test' } }]);
  });

  it('chrome mock: tabs query/sendMessage and injection recording', async () => {
    const mock = createChromeMock();
    installChromeMock(mock);
    mock.setTabs([{ id: 7, url: 'https://y.qq.com/n/ryqq_v2/player' }]);
    mock.respondToTabMessage(7, () => ({ ok: true }));
    const chromeGlobal = mock.chrome as {
      tabs: { query(q: unknown): Promise<Array<{ id: number }>>; sendMessage(id: number, m: unknown): Promise<unknown> };
      scripting: { executeScript(o: { target: { tabId: number }; files: string[] }): Promise<unknown[]> };
    };
    const tabs = await chromeGlobal.tabs.query({});
    expect(tabs.map((tab) => tab.id)).toEqual([7]);
    await expect(chromeGlobal.tabs.sendMessage(7, { kind: 'ping' })).resolves.toEqual({ ok: true });
    await expect(chromeGlobal.tabs.sendMessage(8, { kind: 'ping' })).rejects.toThrow('Receiving end does not exist');
    await chromeGlobal.scripting.executeScript({ target: { tabId: 7 }, files: ['content.js'] });
    expect(mock.injections).toEqual([{ tabId: 7, files: ['content.js'] }]);
    expect(mock.tabMessages.length).toBe(2);
  });

  it('chrome mock: incoming port delivers messages both ways', () => {
    const mock = createChromeMock();
    installChromeMock(mock);
    const runtime = mock.chrome.runtime as {
      onConnect: { addListener(fn: (port: unknown) => void): void };
    };
    const seen: unknown[] = [];
    runtime.onConnect.addListener((port) => {
      const typed = port as { onMessage: { addListener(fn: (m: unknown) => void): void }; postMessage(m: unknown): void };
      typed.onMessage.addListener((message) => { seen.push(message); });
      typed.postMessage({ hello: 'from-worker' });
    });
    const port = mock.connectIncomingPort('content', 7);
    port.emitMessage({ hello: 'from-content' });
    expect(seen).toEqual([{ hello: 'from-content' }]);
    expect(port.sent).toEqual([{ hello: 'from-worker' }]);
  });
});
