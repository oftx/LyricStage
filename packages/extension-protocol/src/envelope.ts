export const PROTOCOL_VERSION = 1 as const;

export type ProtocolChannel =
  | 'playback'
  | 'session'
  | 'surface'
  | 'storage'
  | 'diagnostics'
  | 'bridge';

export type MessageEnvelopeV1 = {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly channel: ProtocolChannel;
  readonly type: string;
  readonly messageId: string;
  readonly sentAtMs: number;
  readonly tabId?: number;
  readonly frameId?: number;
  readonly sessionId?: string;
  readonly generation?: number;
  readonly sequence?: number;
  readonly requestId?: string;
  readonly payload: unknown;
};

const CHANNELS = new Set<ProtocolChannel>([
  'playback',
  'session',
  'surface',
  'storage',
  'diagnostics',
  'bridge',
]);

const ENVELOPE_KEYS = new Set([
  'protocolVersion',
  'channel',
  'type',
  'messageId',
  'sentAtMs',
  'tabId',
  'frameId',
  'sessionId',
  'generation',
  'sequence',
  'requestId',
  'payload',
]);

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type ParseEnvelopeResult =
  | { readonly ok: true; readonly value: MessageEnvelopeV1 }
  | { readonly ok: false; readonly code: 'invalid-envelope' };

/**
 * Own-property-only envelope parse. Prototype-chain fields are ignored; unknown
 * own keys are rejected.
 */
export function parseMessageEnvelopeV1(value: unknown): ParseEnvelopeResult {
  if (!isRecord(value)) return { ok: false, code: 'invalid-envelope' };
  const keys = Object.keys(value);
  if (keys.length === 0 || !keys.every((key) => ENVELOPE_KEYS.has(key))) {
    return { ok: false, code: 'invalid-envelope' };
  }
  if (
    !Object.hasOwn(value, 'protocolVersion')
    || value.protocolVersion !== PROTOCOL_VERSION
    || !Object.hasOwn(value, 'channel')
    || typeof value.channel !== 'string'
    || !CHANNELS.has(value.channel as ProtocolChannel)
    || !Object.hasOwn(value, 'type')
    || typeof value.type !== 'string'
    || value.type.length === 0
    || value.type.length > 128
    || !Object.hasOwn(value, 'messageId')
    || typeof value.messageId !== 'string'
    || value.messageId.length === 0
    || value.messageId.length > 128
    || !Object.hasOwn(value, 'sentAtMs')
    || typeof value.sentAtMs !== 'number'
    || !Number.isFinite(value.sentAtMs)
    || !Object.hasOwn(value, 'payload')
  ) {
    return { ok: false, code: 'invalid-envelope' };
  }

  const optionalNumber = (key: 'tabId' | 'frameId' | 'generation' | 'sequence' | 'sentAtMs') => {
    if (!Object.hasOwn(value, key)) return true;
    const candidate = value[key];
    return typeof candidate === 'number' && Number.isSafeInteger(candidate);
  };
  if (
    !optionalNumber('tabId')
    || !optionalNumber('frameId')
    || !optionalNumber('generation')
    || !optionalNumber('sequence')
  ) {
    return { ok: false, code: 'invalid-envelope' };
  }
  if (Object.hasOwn(value, 'sessionId') && typeof value.sessionId !== 'string') {
    return { ok: false, code: 'invalid-envelope' };
  }
  if (Object.hasOwn(value, 'requestId') && typeof value.requestId !== 'string') {
    return { ok: false, code: 'invalid-envelope' };
  }
  if (Object.hasOwn(value, 'generation') && (value.generation as number) <= 0) {
    return { ok: false, code: 'invalid-envelope' };
  }
  if (Object.hasOwn(value, 'sequence') && (value.sequence as number) <= 0) {
    return { ok: false, code: 'invalid-envelope' };
  }

  return { ok: true, value: value as MessageEnvelopeV1 };
}

export function createMessageEnvelopeV1(
  input: Omit<MessageEnvelopeV1, 'protocolVersion'> & {
    readonly protocolVersion?: typeof PROTOCOL_VERSION;
  },
): MessageEnvelopeV1 {
  const envelope: MessageEnvelopeV1 = {
    protocolVersion: PROTOCOL_VERSION,
    channel: input.channel,
    type: input.type,
    messageId: input.messageId,
    sentAtMs: input.sentAtMs,
    payload: input.payload,
    ...(input.tabId !== undefined ? { tabId: input.tabId } : {}),
    ...(input.frameId !== undefined ? { frameId: input.frameId } : {}),
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
    ...(input.generation !== undefined ? { generation: input.generation } : {}),
    ...(input.sequence !== undefined ? { sequence: input.sequence } : {}),
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
  };
  const parsed = parseMessageEnvelopeV1(envelope);
  if (!parsed.ok) throw new TypeError('invalid message envelope');
  return parsed.value;
}
