// @vitest-environment jsdom
/**
 * P0-1 regression: MAIN-world bridge sequence ordering must be scoped per
 * client (bridgeInstanceId + nonce). A reloaded extension's fresh client
 * starts at sequence 1 and must not be silenced by another client's (or a
 * previous epoch's) high-water mark.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installPageClockMainBridge } from '../src/page-clock/main.js';

const CHANNEL = 'lyric-stage-page-clock-v1';

interface BridgeClient {
  readonly bridgeInstanceId: string;
  readonly nonce: string;
  send(sequence: number, requestId: string): void;
}

function makeClient(name: string): BridgeClient {
  return {
    bridgeInstanceId: `bridge-${name}`,
    nonce: `nonce-${name}-0123456789abcdef`,
    send(sequence: number, requestId: string) {
      // jsdom postMessage does not stamp event.source; dispatch directly so
      // the bridge's same-window and same-origin checks pass.
      window.dispatchEvent(new MessageEvent('message', {
        source: window as unknown as MessageEventSource,
        origin: window.location.origin,
        data: {
          channel: CHANNEL,
          protocolVersion: 1,
          direction: 'isolated-to-main',
          bridgeInstanceId: this.bridgeInstanceId,
          nonce: this.nonce,
          requestId,
          sequence,
          command: { type: 'read-clock' },
        },
      }));
    },
  };
}

function collectResponses(): Array<{ bridgeInstanceId: string; sequence: number; requestId: string }> {
  const responses: Array<{ bridgeInstanceId: string; sequence: number; requestId: string }> = [];
  window.addEventListener('message', (event: MessageEvent<unknown>) => {
    const data = event.data as Record<string, unknown> | null;
    if (data && data.direction === 'main-to-isolated' && data.channel === CHANNEL) {
      responses.push({
        bridgeInstanceId: String(data.bridgeInstanceId),
        sequence: Number(data.sequence),
        requestId: String(data.requestId),
      });
    }
  });
  return responses;
}

async function flushMessages(): Promise<void> {
  // Requests dispatch synchronously; the bridge's response uses real
  // postMessage, which jsdom delivers on a macrotask.
  await new Promise((resolve) => { setTimeout(resolve, 0); });
  await new Promise((resolve) => { setTimeout(resolve, 0); });
}

describe('page-clock bridge per-client sequences', () => {
  beforeEach(() => {
    // jsdom in this vitest version lacks origin on window.postMessage
    // round-trips being distinguishable; the bridge accepts same-window
    // messages whose origin matches location.origin (or empty).
    installPageClockMainBridge({ open: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a low-sequence client is not silenced by another client at a huge sequence', async () => {
    const responses = collectResponses();
    const clientA = makeClient('a');
    const clientB = makeClient('b');

    clientA.send(9_007_199_254_740_000, 'a-huge');
    await flushMessages();
    // Reloaded-extension scenario: fresh client starts from 1.
    clientB.send(1, 'b-1');
    clientB.send(2, 'b-2');
    await flushMessages();

    const bResponses = responses.filter((entry) => entry.bridgeInstanceId === 'bridge-b');
    expect(bResponses.map((entry) => entry.requestId)).toEqual(['b-1', 'b-2']);
  });

  it('still rejects replayed and out-of-order sequences within one client', async () => {
    const responses = collectResponses();
    const client = makeClient('c');
    client.send(5, 'c-5');
    await flushMessages();
    client.send(5, 'c-5-replay');
    client.send(4, 'c-4-stale');
    client.send(6, 'c-6');
    await flushMessages();

    const ids = responses
      .filter((entry) => entry.bridgeInstanceId === 'bridge-c')
      .map((entry) => entry.requestId);
    expect(ids).toEqual(['c-5', 'c-6']);
  });
});
