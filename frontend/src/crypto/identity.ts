import {
  DEFAULT_KEY_HISTORY_LIMIT,
  DEFAULT_KEY_MAX_AGE_MS,
  ONE_TIME_PREKEY_TARGET,
  SIGNED_PREKEY_HISTORY_LIMIT,
} from './constants';
import { deleteAllSessionsForUser, readIdentityRecord, writeIdentityRecord } from './store';
import type {
  Identity,
  PersistedIdentityRecord,
  PersistedOneTimePreKey,
  PersistedSignedPreKey,
  RotationResult,
  SignalPreKeyBundleUpload,
} from './types';
import {
  canonicalSignedPreKeyPayload,
  createKeyID,
  requireCryptoSupport,
  sanitizePositiveInt,
  signingKeyFingerprint,
  toBase64,
} from './utils';
import { normalizeECDSASignatureForTransport } from './signature';

async function importECDHPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
}

async function importECDHPublicKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    [],
  );
}

async function generateECDHKeyPair(): Promise<{
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicKeyJwk: JsonWebKey;
}> {
  const generated = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  ) as CryptoKeyPair;
  const privateKeyJwk = await crypto.subtle.exportKey('jwk', generated.privateKey);
  const publicKeyJwk = await crypto.subtle.exportKey('jwk', generated.publicKey);
  const privateKey = await importECDHPrivateKey(privateKeyJwk);
  const publicKey = await importECDHPublicKey(publicKeyJwk);
  return {
    privateKey,
    publicKey,
    publicKeyJwk,
  };
}

async function generateSigningKeyMaterial(): Promise<{
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicKeyJwk: JsonWebKey;
}> {
  const generated = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  ) as CryptoKeyPair;
  const publicKeyJwk = await crypto.subtle.exportKey('jwk', generated.publicKey);
  const privateKeyJwk = await crypto.subtle.exportKey('jwk', generated.privateKey);
  const signingPrivateKey = await crypto.subtle.importKey(
    'jwk',
    privateKeyJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign'],
  );
  const signingPublicKey = await crypto.subtle.importKey(
    'jwk',
    publicKeyJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify'],
  );
  return {
    privateKey: signingPrivateKey,
    publicKey: signingPublicKey,
    publicKeyJwk,
  };
}

async function createSignedPreKey(
  keyID: number,
  signingPrivateKey: CryptoKey,
): Promise<PersistedSignedPreKey> {
  const generated = await generateECDHKeyPair();
  const canonical = canonicalSignedPreKeyPayload(generated.publicKeyJwk);
  const signatureRaw = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    signingPrivateKey,
    new TextEncoder().encode(canonical),
  );
  const normalizedSignature = normalizeECDSASignatureForTransport(signatureRaw);
  return {
    keyID,
    createdAt: new Date().toISOString(),
    publicKeyJwk: generated.publicKeyJwk,
    privateKey: generated.privateKey,
    signature: toBase64(normalizedSignature),
  };
}

async function createOneTimePreKeys(startKeyID: number, count: number): Promise<PersistedOneTimePreKey[]> {
  const next: PersistedOneTimePreKey[] = [];
  for (let index = 0; index < count; index += 1) {
    const generated = await generateECDHKeyPair();
    next.push({
      keyID: startKeyID + index,
      createdAt: new Date().toISOString(),
      publicKeyJwk: generated.publicKeyJwk,
      privateKey: generated.privateKey,
    });
  }
  return next;
}

function signedPreKeyAgeMs(entry: PersistedSignedPreKey): number {
  const parsed = Date.parse(entry.createdAt);
  if (!Number.isFinite(parsed)) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Math.max(0, Date.now() - parsed);
}

function hasPersistablePrivateKeys(record: PersistedIdentityRecord): boolean {
  if (!record.identityPrivateKey.extractable || !record.signingPrivateKey.extractable) {
    return false;
  }
  for (const signedPreKey of record.signedPreKeys) {
    if (!signedPreKey.privateKey.extractable) {
      return false;
    }
  }
  for (const oneTimePreKey of record.oneTimePreKeys) {
    if (!oneTimePreKey.privateKey.extractable) {
      return false;
    }
  }
  return true;
}

function toIdentity(record: PersistedIdentityRecord): Identity {
  const active = record.signedPreKeys.find((entry) => entry.keyID === record.activeSignedPreKeyID)
    ?? record.signedPreKeys[record.signedPreKeys.length - 1];
  return {
    userID: record.userID,
    activeKeyID: record.deviceID,
    privateKey: record.identityPrivateKey,
    publicKey: record.identityPublicKey,
    publicKeyJwk: record.identityPublicKeyJwk,
    signingPrivateKey: record.signingPrivateKey,
    signingPublicKey: record.signingPublicKey,
    signingPublicKeyJwk: record.signingPublicKeyJwk,
    signedPreKey: active,
    signedPreKeys: [...record.signedPreKeys],
    oneTimePreKeys: [...record.oneTimePreKeys],
    privateKeys: [record.identityPrivateKey],
    publicKeys: [record.identityPublicKeyJwk],
    rotatedAt: active.createdAt,
  };
}

async function createIdentityRecord(userID: number): Promise<PersistedIdentityRecord> {
  const identity = await generateECDHKeyPair();
  const signing = await generateSigningKeyMaterial();
  const signedPreKey = await createSignedPreKey(1, signing.privateKey);
  const oneTimePreKeys = await createOneTimePreKeys(1, ONE_TIME_PREKEY_TARGET);

  const record: PersistedIdentityRecord = {
    userID,
    deviceID: createKeyID(),
    identityPrivateKey: identity.privateKey,
    identityPublicKey: identity.publicKey,
    identityPublicKeyJwk: identity.publicKeyJwk,
    signingPrivateKey: signing.privateKey,
    signingPublicKey: signing.publicKey,
    signingPublicKeyJwk: signing.publicKeyJwk,
    signedPreKeys: [signedPreKey],
    activeSignedPreKeyID: signedPreKey.keyID,
    oneTimePreKeys,
    nextOneTimePreKeyID: oneTimePreKeys.length + 1,
    updatedAt: new Date().toISOString(),
  };
  await writeIdentityRecord(record);
  return record;
}

async function ensureIdentityRecord(
  userID: number,
  preferredDeviceID: string | null,
  maxAgeMs: number,
  signedPreKeyHistoryLimit: number,
  oneTimePreKeyTarget: number,
): Promise<{ record: PersistedIdentityRecord; changed: boolean }> {
  const existing = await readIdentityRecord(userID);
  if (!existing) {
    await deleteAllSessionsForUser(userID);
    const created = await createIdentityRecord(userID);
    if (preferredDeviceID && preferredDeviceID !== created.deviceID) {
      const patched = { ...created, deviceID: preferredDeviceID };
      await writeIdentityRecord(patched);
      return { record: patched, changed: true };
    }
    return { record: created, changed: true };
  }

  if (!hasPersistablePrivateKeys(existing)) {
    await deleteAllSessionsForUser(userID);
    return {
      record: await createIdentityRecord(userID),
      changed: true,
    };
  }

  let changed = false;
  let nextRecord = existing;

  if (preferredDeviceID && nextRecord.deviceID !== preferredDeviceID) {
    nextRecord = {
      ...nextRecord,
      deviceID: preferredDeviceID,
      updatedAt: new Date().toISOString(),
    };
    await deleteAllSessionsForUser(userID);
    changed = true;
  }

  const active = nextRecord.signedPreKeys.find((entry) => entry.keyID === nextRecord.activeSignedPreKeyID)
    ?? nextRecord.signedPreKeys[nextRecord.signedPreKeys.length - 1];

  if (
    signedPreKeyAgeMs(active) >= maxAgeMs
    || signingKeyFingerprint(nextRecord.signingPublicKeyJwk) === ''
  ) {
    const nextKeyID = nextRecord.signedPreKeys.reduce((max, entry) => Math.max(max, entry.keyID), 0) + 1;
    const nextSignedPreKey = await createSignedPreKey(nextKeyID, nextRecord.signingPrivateKey);
    const mergedSignedPreKeys = [...nextRecord.signedPreKeys, nextSignedPreKey];
    const trimmedSignedPreKeys = mergedSignedPreKeys.length > signedPreKeyHistoryLimit
      ? mergedSignedPreKeys.slice(mergedSignedPreKeys.length - signedPreKeyHistoryLimit)
      : mergedSignedPreKeys;
    nextRecord = {
      ...nextRecord,
      signedPreKeys: trimmedSignedPreKeys,
      activeSignedPreKeyID: nextSignedPreKey.keyID,
      updatedAt: new Date().toISOString(),
    };
    changed = true;
  }

  if (nextRecord.oneTimePreKeys.length < oneTimePreKeyTarget) {
    const missing = oneTimePreKeyTarget - nextRecord.oneTimePreKeys.length;
    const additions = await createOneTimePreKeys(nextRecord.nextOneTimePreKeyID, missing);
    nextRecord = {
      ...nextRecord,
      oneTimePreKeys: [...nextRecord.oneTimePreKeys, ...additions],
      nextOneTimePreKeyID: nextRecord.nextOneTimePreKeyID + additions.length,
      updatedAt: new Date().toISOString(),
    };
    changed = true;
  }

  if (changed) {
    await writeIdentityRecord(nextRecord);
  }
  return {
    record: nextRecord,
    changed,
  };
}

function toSignedPreKeyHistoryLimit(historyLimit: number): number {
  const safeHistoryLimit = sanitizePositiveInt(historyLimit, DEFAULT_KEY_HISTORY_LIMIT);
  return Math.max(2, Math.min(SIGNED_PREKEY_HISTORY_LIMIT, safeHistoryLimit));
}

function toOneTimePreKeyTarget(historyLimit: number): number {
  const safeHistoryLimit = sanitizePositiveInt(historyLimit, DEFAULT_KEY_HISTORY_LIMIT);
  return Math.max(24, Math.min(ONE_TIME_PREKEY_TARGET, safeHistoryLimit * 16));
}

export async function loadOrCreateIdentity(userID: number): Promise<Identity> {
  requireCryptoSupport();
  const { record } = await ensureIdentityRecord(
    userID,
    null,
    DEFAULT_KEY_MAX_AGE_MS,
    toSignedPreKeyHistoryLimit(DEFAULT_KEY_HISTORY_LIMIT),
    ONE_TIME_PREKEY_TARGET,
  );
  return toIdentity(record);
}

export async function loadOrCreateIdentityForDevice(userID: number, deviceID: string): Promise<Identity> {
  requireCryptoSupport();
  const normalizedDeviceID = deviceID.trim();
  const { record } = await ensureIdentityRecord(
    userID,
    normalizedDeviceID || null,
    DEFAULT_KEY_MAX_AGE_MS,
    toSignedPreKeyHistoryLimit(DEFAULT_KEY_HISTORY_LIMIT),
    ONE_TIME_PREKEY_TARGET,
  );
  return toIdentity(record);
}

export async function rotateIdentityIfNeeded(
  userID: number,
  deviceID: string | null = null,
  maxAgeMs = DEFAULT_KEY_MAX_AGE_MS,
  historyLimit = DEFAULT_KEY_HISTORY_LIMIT,
): Promise<RotationResult> {
  requireCryptoSupport();

  const safeMaxAgeMs = sanitizePositiveInt(maxAgeMs, DEFAULT_KEY_MAX_AGE_MS);
  const signedPreKeyHistoryLimit = toSignedPreKeyHistoryLimit(historyLimit);
  const oneTimePreKeyTarget = toOneTimePreKeyTarget(historyLimit);

  const { record, changed } = await ensureIdentityRecord(
    userID,
    deviceID && deviceID.trim() ? deviceID.trim() : null,
    safeMaxAgeMs,
    signedPreKeyHistoryLimit,
    oneTimePreKeyTarget,
  );

  return {
    identity: toIdentity(record),
    rotated: changed,
  };
}

export function toSignalPreKeyBundleUpload(identity: Identity): SignalPreKeyBundleUpload {
  return {
    identityKeyJwk: identity.publicKeyJwk,
    identitySigningPublicKeyJwk: identity.signingPublicKeyJwk,
    signedPreKey: {
      keyId: identity.signedPreKey.keyID,
      publicKeyJwk: identity.signedPreKey.publicKeyJwk,
      signature: identity.signedPreKey.signature,
    },
    oneTimePreKeys: identity.oneTimePreKeys.map((entry) => ({
      keyId: entry.keyID,
      publicKeyJwk: entry.publicKeyJwk,
    })),
  };
}

export function findSignedPreKey(identity: Identity, keyID: number): PersistedSignedPreKey | null {
  return identity.signedPreKeys.find((entry) => entry.keyID === keyID) ?? null;
}

export async function consumeOneTimePreKey(identity: Identity, keyID: number): Promise<void> {
  if (!Number.isFinite(keyID) || keyID <= 0) {
    return;
  }
  const existing = await readIdentityRecord(identity.userID);
  if (!existing) {
    return;
  }
  const nextOneTimePreKeys = existing.oneTimePreKeys.filter((entry) => entry.keyID !== keyID);
  if (nextOneTimePreKeys.length === existing.oneTimePreKeys.length) {
    return;
  }
  const nextRecord: PersistedIdentityRecord = {
    ...existing,
    oneTimePreKeys: nextOneTimePreKeys,
    updatedAt: new Date().toISOString(),
  };
  await writeIdentityRecord(nextRecord);

  identity.oneTimePreKeys = identity.oneTimePreKeys.filter((entry) => entry.keyID !== keyID);
}

export function findOneTimePreKey(identity: Identity, keyID: number): PersistedOneTimePreKey | null {
  return identity.oneTimePreKeys.find((entry) => entry.keyID === keyID) ?? null;
}
