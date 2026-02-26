import { describe, expect, it } from 'vitest';
import {
  normalizeECDSASignatureForTransport,
  verifyECDSASignatureWithFallback,
} from './signature';

function trimIntegerForDER(input: Uint8Array): Uint8Array {
  let offset = 0;
  while (offset < input.length - 1 && input[offset] === 0) {
    offset += 1;
  }
  const trimmed = input.slice(offset);
  if ((trimmed[0] & 0x80) !== 0) {
    const next = new Uint8Array(trimmed.length + 1);
    next[0] = 0;
    next.set(trimmed, 1);
    return next;
  }
  return trimmed;
}

function encodeDERLength(value: number): number[] {
  if (value < 0x80) {
    return [value];
  }
  return [0x81, value];
}

function rawToDer(signature: Uint8Array): Uint8Array {
  const r = trimIntegerForDER(signature.slice(0, 32));
  const s = trimIntegerForDER(signature.slice(32));
  const rLength = encodeDERLength(r.length);
  const sLength = encodeDERLength(s.length);
  const bodyLength = 1 + rLength.length + r.length + 1 + sLength.length + s.length;
  const sequenceLength = encodeDERLength(bodyLength);
  const output = new Uint8Array(1 + sequenceLength.length + bodyLength);
  let offset = 0;
  output[offset] = 0x30;
  offset += 1;
  output.set(sequenceLength, offset);
  offset += sequenceLength.length;
  output[offset] = 0x02;
  offset += 1;
  output.set(rLength, offset);
  offset += rLength.length;
  output.set(r, offset);
  offset += r.length;
  output[offset] = 0x02;
  offset += 1;
  output.set(sLength, offset);
  offset += sLength.length;
  output.set(s, offset);
  return output;
}

describe('signature compatibility helpers', () => {
  it('normalizes DER signatures to raw 64-byte transport format', async () => {
    const message = new TextEncoder().encode('hello-signature');
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    ) as CryptoKeyPair;
    const original = new Uint8Array(await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      keyPair.privateKey,
      message,
    ));

    const raw = normalizeECDSASignatureForTransport(original);
    expect(raw).toHaveLength(64);

    const der = rawToDer(raw);
    const normalized = normalizeECDSASignatureForTransport(der);
    expect(normalized).toEqual(raw);
  });

  it('verifies both raw and DER ECDSA signatures', async () => {
    const message = new TextEncoder().encode('verify-der-and-raw');
    const keyPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    ) as CryptoKeyPair;
    const signed = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      keyPair.privateKey,
      message,
    );
    const raw = normalizeECDSASignatureForTransport(signed);
    const der = rawToDer(raw);

    const verifiedRaw = await verifyECDSASignatureWithFallback(keyPair.publicKey, message, raw);
    const verifiedDer = await verifyECDSASignatureWithFallback(keyPair.publicKey, message, der);
    expect(verifiedRaw).toBe(true);
    expect(verifiedDer).toBe(true);
  });
});
