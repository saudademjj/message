import type { CipherPayload } from '../types';
import { DR_MAX_SKIPPED_CACHE } from './constants';

export function requireCryptoSupport(): void {
  if (!window.isSecureContext || !crypto?.subtle) {
    throw new Error('Web Crypto requires HTTPS secure context');
  }
  if (!window.indexedDB) {
    throw new Error('IndexedDB is required for secure key storage');
  }
}

export function toBase64(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function fromBase64(input: string): ArrayBuffer {
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

export function concatBuffers(...buffers: ArrayBuffer[]): ArrayBuffer {
  const total = buffers.reduce((sum, current) => sum + current.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const buffer of buffers) {
    merged.set(new Uint8Array(buffer), offset);
    offset += buffer.byteLength;
  }
  return merged.buffer;
}

export function createKeyID(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const random = Math.random().toString(16).slice(2, 10);
  return `key-${Date.now()}-${random}`;
}

export function buildSessionID(userID: number, peerUserID: number): string {
  return `${userID}:${peerUserID}`;
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isCryptoKey(value: unknown): value is CryptoKey {
  return typeof CryptoKey !== 'undefined' && value instanceof CryptoKey;
}

function sortJSON(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJSON(item));
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, current]) => [key, sortJSON(current)]);
    return Object.fromEntries(entries);
  }
  return value;
}

export function stableJSONStringify(value: unknown): string {
  return JSON.stringify(sortJSON(value));
}

export function normalizeCounter(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return Math.floor(parsed);
}

export function sanitizePositiveInt(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

export function activeKeyAgeMs(createdAt: string): number {
  const parsed = Date.parse(createdAt);
  if (!Number.isFinite(parsed)) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Math.max(0, Date.now() - parsed);
}

export function signingKeyFingerprint(jwk: JsonWebKey | null | undefined): string {
  if (!jwk) {
    return '';
  }
  return stableJSONStringify(jwk);
}

export function ratchetKeyFingerprint(jwk: JsonWebKey | null | undefined): string {
  if (!jwk) {
    return '';
  }
  const kty = typeof jwk.kty === 'string' ? jwk.kty : '';
  const crv = typeof jwk.crv === 'string' ? jwk.crv : '';
  const x = typeof jwk.x === 'string' ? jwk.x : '';
  const y = typeof jwk.y === 'string' ? jwk.y : '';
  return `${kty}|${crv}|${x}|${y}`;
}

export function trimSkippedCache(skipped: Record<string, string>): Record<string, string> {
  const entries = Object.entries(skipped);
  if (entries.length <= DR_MAX_SKIPPED_CACHE) {
    return skipped;
  }
  const nextEntries = entries.slice(entries.length - DR_MAX_SKIPPED_CACHE);
  return Object.fromEntries(nextEntries);
}

export function canonicalCipherPayloadForSignature(payload: CipherPayload): string {
  const wrappedEntries = Object.keys(payload.wrappedKeys)
    .sort((left, right) => left.localeCompare(right))
    .map((recipientID) => {
      const wrapped = payload.wrappedKeys[recipientID];
      const preKeyMessage = wrapped.preKeyMessage
        ? {
            identityKeyJwk: wrapped.preKeyMessage.identityKeyJwk,
            identitySigningPublicKeyJwk: wrapped.preKeyMessage.identitySigningPublicKeyJwk ?? null,
            ephemeralKeyJwk: wrapped.preKeyMessage.ephemeralKeyJwk,
            signedPreKeyId: normalizeCounter(wrapped.preKeyMessage.signedPreKeyId),
            oneTimePreKeyId: wrapped.preKeyMessage.oneTimePreKeyId == null
              ? null
              : normalizeCounter(wrapped.preKeyMessage.oneTimePreKeyId),
            preKeyBundleUpdatedAt: wrapped.preKeyMessage.preKeyBundleUpdatedAt ?? '',
          }
        : null;
      return {
        recipientId: recipientID,
        iv: wrapped.iv,
        wrappedKey: wrapped.wrappedKey,
        ratchetDhPublicKeyJwk: wrapped.ratchetDhPublicKeyJwk ?? null,
        preKeyMessage,
        messageNumber: normalizeCounter(wrapped.messageNumber),
        previousChainLength: normalizeCounter(wrapped.previousChainLength),
        sessionVersion: normalizeCounter(wrapped.sessionVersion),
      };
    });

  return stableJSONStringify({
    version: normalizeCounter(payload.version),
    ciphertext: payload.ciphertext,
    messageIv: payload.messageIv,
    wrappedKeys: wrappedEntries,
    senderPublicKeyJwk: payload.senderPublicKeyJwk,
    senderSigningPublicKeyJwk: payload.senderSigningPublicKeyJwk ?? null,
    contentType: payload.contentType ?? '',
    senderDeviceId: payload.senderDeviceId ?? '',
    encryptionScheme: payload.encryptionScheme ?? '',
  });
}

export function canonicalSignedPreKeyPayload(publicKeyJwk: JsonWebKey): string {
  return stableJSONStringify({
    type: 'signal-signed-prekey',
    publicKeyJwk,
  });
}

export function canonicalAckPayloadForSignature(roomID: number, messageID: number, fromUserID: number): string {
  const normalizedRoomID = normalizeCounter(roomID);
  const normalizedMessageID = normalizeCounter(messageID);
  const normalizedFromUserID = normalizeCounter(fromUserID);
  if (!normalizedRoomID || !normalizedMessageID || !normalizedFromUserID) {
    throw new Error('invalid ack payload');
  }
  return stableJSONStringify({
    type: 'decrypt_ack',
    roomId: normalizedRoomID,
    messageId: normalizedMessageID,
    fromUserId: normalizedFromUserID,
  });
}
