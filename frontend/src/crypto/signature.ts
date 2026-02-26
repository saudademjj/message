function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((value) => value.toString(16).padStart(2, '0')).join('');
}

function readDERLength(bytes: Uint8Array, offset: number): { value: number; nextOffset: number } | null {
  if (offset >= bytes.length) {
    return null;
  }
  const first = bytes[offset];
  if ((first & 0x80) === 0) {
    return { value: first, nextOffset: offset + 1 };
  }
  const lengthBytes = first & 0x7f;
  if (lengthBytes <= 0 || lengthBytes > 2 || offset + 1 + lengthBytes > bytes.length) {
    return null;
  }
  let value = 0;
  for (let index = 0; index < lengthBytes; index += 1) {
    value = (value << 8) | bytes[offset + 1 + index];
  }
  return { value, nextOffset: offset + 1 + lengthBytes };
}

function encodeDERLength(value: number): number[] {
  if (value < 0x80) {
    return [value];
  }
  if (value <= 0xff) {
    return [0x81, value];
  }
  return [0x82, (value >> 8) & 0xff, value & 0xff];
}

function stripLeadingZeros(bytes: Uint8Array): Uint8Array {
  let offset = 0;
  while (offset < bytes.length - 1 && bytes[offset] === 0) {
    offset += 1;
  }
  return bytes.slice(offset);
}

function trimIntegerForDER(input: Uint8Array): Uint8Array {
  const trimmed = stripLeadingZeros(input);
  if (trimmed.length === 0) {
    return new Uint8Array([0]);
  }
  if ((trimmed[0] & 0x80) !== 0) {
    const next = new Uint8Array(trimmed.length + 1);
    next[0] = 0;
    next.set(trimmed, 1);
    return next;
  }
  return trimmed;
}

function parseDERInteger(bytes: Uint8Array, offset: number): { value: Uint8Array; nextOffset: number } | null {
  if (offset >= bytes.length || bytes[offset] !== 0x02) {
    return null;
  }
  const length = readDERLength(bytes, offset + 1);
  if (!length) {
    return null;
  }
  const end = length.nextOffset + length.value;
  if (end > bytes.length || length.value <= 0) {
    return null;
  }
  const value = bytes.slice(length.nextOffset, end);
  return { value, nextOffset: end };
}

function ecdsaDERToRaw(signature: Uint8Array): Uint8Array | null {
  if (signature.length < 8 || signature[0] !== 0x30) {
    return null;
  }
  const sequenceLength = readDERLength(signature, 1);
  if (!sequenceLength) {
    return null;
  }
  const sequenceEnd = sequenceLength.nextOffset + sequenceLength.value;
  if (sequenceEnd !== signature.length) {
    return null;
  }
  const first = parseDERInteger(signature, sequenceLength.nextOffset);
  if (!first) {
    return null;
  }
  const second = parseDERInteger(signature, first.nextOffset);
  if (!second || second.nextOffset !== sequenceEnd) {
    return null;
  }

  const r = stripLeadingZeros(first.value);
  const s = stripLeadingZeros(second.value);
  if (r.length > 32 || s.length > 32) {
    return null;
  }
  const output = new Uint8Array(64);
  output.set(r, 32 - r.length);
  output.set(s, 64 - s.length);
  return output;
}

function ecdsaRawToDER(signature: Uint8Array): Uint8Array | null {
  if (signature.length !== 64) {
    return null;
  }
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

function toUint8Array(signature: ArrayBuffer | Uint8Array): Uint8Array {
  if (signature instanceof Uint8Array) {
    return signature;
  }
  return new Uint8Array(signature);
}

export function normalizeECDSASignatureForTransport(signature: ArrayBuffer | Uint8Array): Uint8Array {
  const bytes = toUint8Array(signature);
  if (bytes.length === 64) {
    return bytes;
  }
  const raw = ecdsaDERToRaw(bytes);
  return raw ?? bytes;
}

function signatureVariants(signature: Uint8Array): Uint8Array[] {
  const variants: Uint8Array[] = [signature];
  if (signature.length === 64) {
    const der = ecdsaRawToDER(signature);
    if (der) {
      variants.push(der);
    }
  } else {
    const raw = ecdsaDERToRaw(signature);
    if (raw) {
      variants.push(raw);
    }
  }
  const deduped = new Map<string, Uint8Array>();
  for (const candidate of variants) {
    deduped.set(bytesToHex(candidate), candidate);
  }
  return [...deduped.values()];
}

export async function verifyECDSASignatureWithFallback(
  publicKey: CryptoKey,
  payload: Uint8Array,
  signature: ArrayBuffer | Uint8Array,
): Promise<boolean> {
  const bytes = toUint8Array(signature);
  const payloadCopy = new Uint8Array(payload.byteLength);
  payloadCopy.set(payload);
  for (const candidate of signatureVariants(bytes)) {
    const candidateCopy = new Uint8Array(candidate.byteLength);
    candidateCopy.set(candidate);
    const verified = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      candidateCopy,
      payloadCopy,
    );
    if (verified) {
      return true;
    }
  }
  return false;
}
