import {
  IDENTITY_STORE,
  SECURE_DB_NAME,
  SECURE_DB_VERSION,
  SESSION_STORE,
} from './constants';
import type {
  PendingPreKeyState,
  PersistedIdentityRecord,
  PersistedOneTimePreKey,
  PersistedSignedPreKey,
  RatchetSessionRecord,
} from './types';
import { buildSessionID, isCryptoKey, isObject } from './utils';

// In-memory caches — protects against silent IDB write failures (common on mobile Safari)
const sessionCache = new Map<string, RatchetSessionRecord>();
const identityCache = new Map<number, PersistedIdentityRecord>();

function isJWKLike(value: unknown): value is JsonWebKey {
  return isObject(value) && typeof value.kty === 'string';
}

async function importECDHPrivateKeyJWK(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
}

async function importECDHPublicKeyJWK(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    [],
  );
}

async function importECDSAPrivateKeyJWK(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign'],
  );
}

async function importECDSAPublicKeyJWK(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify'],
  );
}

async function exportKeyJWK(key: CryptoKey): Promise<JsonWebKey | null> {
  try {
    return await crypto.subtle.exportKey('jwk', key);
  } catch {
    return null;
  }
}

function openSecureDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    // Timeout to prevent indefinite hang on mobile Safari
    const timer = setTimeout(() => {
      reject(new Error('IndexedDB open timeout (5s)'));
    }, 5000);
    let resolved = false;
    const request = indexedDB.open(SECURE_DB_NAME, SECURE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDENTITY_STORE)) {
        db.createObjectStore(IDENTITY_STORE, { keyPath: 'userID' });
      }
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        db.createObjectStore(SESSION_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve(request.result);
      }
    };
    request.onerror = () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        reject(request.error ?? new Error('failed to open secure store'));
      }
    };
  });
}

function normalizePendingPreKey(raw: unknown): PendingPreKeyState | null {
  if (!isObject(raw)) {
    return null;
  }
  const signedPreKeyId = Number(raw.signedPreKeyId);
  if (!Number.isFinite(signedPreKeyId) || signedPreKeyId <= 0) {
    return null;
  }
  const identityKeyJwk = isObject(raw.identityKeyJwk) ? (raw.identityKeyJwk as JsonWebKey) : null;
  const identitySigningPublicKeyJwk = isObject(raw.identitySigningPublicKeyJwk)
    ? (raw.identitySigningPublicKeyJwk as JsonWebKey)
    : null;
  const ephemeralKeyJwk = isObject(raw.ephemeralKeyJwk) ? (raw.ephemeralKeyJwk as JsonWebKey) : null;
  if (!identityKeyJwk || !identitySigningPublicKeyJwk || !ephemeralKeyJwk) {
    return null;
  }
  if (
    identityKeyJwk.crv !== 'P-256'
    || identitySigningPublicKeyJwk.crv !== 'P-256'
    || ephemeralKeyJwk.crv !== 'P-256'
  ) {
    return null;
  }
  const oneTimePreKeyIdRaw = raw.oneTimePreKeyId;
  const oneTimePreKeyId = oneTimePreKeyIdRaw == null
    ? null
    : Number.isFinite(Number(oneTimePreKeyIdRaw)) && Number(oneTimePreKeyIdRaw) > 0
      ? Math.floor(Number(oneTimePreKeyIdRaw))
      : null;
  return {
    identityKeyJwk,
    identitySigningPublicKeyJwk,
    ephemeralKeyJwk,
    signedPreKeyId: Math.floor(signedPreKeyId),
    oneTimePreKeyId,
    preKeyBundleUpdatedAt: typeof raw.preKeyBundleUpdatedAt === 'string'
      ? raw.preKeyBundleUpdatedAt
      : new Date().toISOString(),
  };
}

function normalizeSignedPreKeys(raw: unknown): PersistedSignedPreKey[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const next: PersistedSignedPreKey[] = [];
  for (const entry of raw) {
    if (!isObject(entry)) {
      continue;
    }
    const keyID = Number(entry.keyID);
    const publicKeyJwk = isObject(entry.publicKeyJwk) ? (entry.publicKeyJwk as JsonWebKey) : null;
    const privateKey = isCryptoKey(entry.privateKey) ? entry.privateKey : null;
    const signature = typeof entry.signature === 'string' ? entry.signature.trim() : '';
    if (
      !Number.isFinite(keyID)
      || keyID <= 0
      || !publicKeyJwk
      || publicKeyJwk.crv !== 'P-256'
      || !privateKey
      || !signature
    ) {
      continue;
    }
    next.push({
      keyID: Math.floor(keyID),
      createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date().toISOString(),
      publicKeyJwk,
      privateKey,
      signature,
    });
  }
  return next;
}

function normalizeOneTimePreKeys(raw: unknown): PersistedOneTimePreKey[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const next: PersistedOneTimePreKey[] = [];
  for (const entry of raw) {
    if (!isObject(entry)) {
      continue;
    }
    const keyID = Number(entry.keyID);
    const publicKeyJwk = isObject(entry.publicKeyJwk) ? (entry.publicKeyJwk as JsonWebKey) : null;
    const privateKey = isCryptoKey(entry.privateKey) ? entry.privateKey : null;
    if (
      !Number.isFinite(keyID)
      || keyID <= 0
      || !publicKeyJwk
      || publicKeyJwk.crv !== 'P-256'
      || !privateKey
    ) {
      continue;
    }
    next.push({
      keyID: Math.floor(keyID),
      createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date().toISOString(),
      publicKeyJwk,
      privateKey,
    });
  }
  return next;
}

async function hydrateIdentityRecordFromJWK(raw: unknown, userID: number): Promise<PersistedIdentityRecord | null> {
  if (!isObject(raw)) {
    return null;
  }
  const identityPrivateKeyJwk = isJWKLike(raw.identityPrivateKeyJwk) ? raw.identityPrivateKeyJwk : null;
  const identityPublicKeyJwk = isJWKLike(raw.identityPublicKeyJwk) ? raw.identityPublicKeyJwk : null;
  const signingPrivateKeyJwk = isJWKLike(raw.signingPrivateKeyJwk) ? raw.signingPrivateKeyJwk : null;
  const signingPublicKeyJwk = isJWKLike(raw.signingPublicKeyJwk) ? raw.signingPublicKeyJwk : null;
  if (!identityPrivateKeyJwk || !identityPublicKeyJwk || !signingPrivateKeyJwk || !signingPublicKeyJwk) {
    return null;
  }
  if (
    identityPublicKeyJwk.crv !== 'P-256'
    || signingPublicKeyJwk.crv !== 'P-256'
    || identityPrivateKeyJwk.crv !== 'P-256'
    || signingPrivateKeyJwk.crv !== 'P-256'
  ) {
    return null;
  }

  const signedPreKeysRaw = Array.isArray(raw.signedPreKeys) ? raw.signedPreKeys : [];
  const oneTimePreKeysRaw = Array.isArray(raw.oneTimePreKeys) ? raw.oneTimePreKeys : [];

  const signedPreKeysResolved: PersistedSignedPreKey[] = [];
  for (const entry of signedPreKeysRaw) {
    if (!isObject(entry)) {
      continue;
    }
    const keyID = Number(entry.keyID);
    const publicKeyJwk = isJWKLike(entry.publicKeyJwk) ? entry.publicKeyJwk : null;
    const privateKeyJwk = isJWKLike(entry.privateKeyJwk) ? entry.privateKeyJwk : null;
    const signature = typeof entry.signature === 'string' ? entry.signature.trim() : '';
    if (
      !Number.isFinite(keyID) ||
      keyID <= 0 ||
      !publicKeyJwk ||
      !privateKeyJwk ||
      !signature ||
      publicKeyJwk.crv !== 'P-256' ||
      privateKeyJwk.crv !== 'P-256'
    ) {
      continue;
    }
    try {
      const privateKey = await importECDHPrivateKeyJWK(privateKeyJwk);
      signedPreKeysResolved.push({
        keyID: Math.floor(keyID),
        createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date().toISOString(),
        publicKeyJwk,
        privateKey,
        signature,
      });
    } catch {
      continue;
    }
  }
  if (signedPreKeysResolved.length === 0) {
    return null;
  }

  const oneTimePreKeysResolved: PersistedOneTimePreKey[] = [];
  for (const entry of oneTimePreKeysRaw) {
    if (!isObject(entry)) {
      continue;
    }
    const keyID = Number(entry.keyID);
    const publicKeyJwk = isJWKLike(entry.publicKeyJwk) ? entry.publicKeyJwk : null;
    const privateKeyJwk = isJWKLike(entry.privateKeyJwk) ? entry.privateKeyJwk : null;
    if (
      !Number.isFinite(keyID) ||
      keyID <= 0 ||
      !publicKeyJwk ||
      !privateKeyJwk ||
      publicKeyJwk.crv !== 'P-256' ||
      privateKeyJwk.crv !== 'P-256'
    ) {
      continue;
    }
    try {
      const privateKey = await importECDHPrivateKeyJWK(privateKeyJwk);
      oneTimePreKeysResolved.push({
        keyID: Math.floor(keyID),
        createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date().toISOString(),
        publicKeyJwk,
        privateKey,
      });
    } catch {
      continue;
    }
  }

  const activeSignedPreKeyIDRaw = Number(raw.activeSignedPreKeyID);
  const activeSignedPreKey = signedPreKeysResolved.find((entry) => entry.keyID === Math.floor(activeSignedPreKeyIDRaw));
  const activeSignedPreKeyID = activeSignedPreKey
    ? activeSignedPreKey.keyID
    : signedPreKeysResolved[signedPreKeysResolved.length - 1].keyID;

  const maxKnownOneTimePreKeyID = oneTimePreKeysResolved.reduce((max, item) => Math.max(max, item.keyID), 0);
  const nextOneTimePreKeyIDRaw = Number(raw.nextOneTimePreKeyID);
  const nextOneTimePreKeyID = Number.isFinite(nextOneTimePreKeyIDRaw) && nextOneTimePreKeyIDRaw > maxKnownOneTimePreKeyID
    ? Math.floor(nextOneTimePreKeyIDRaw)
    : maxKnownOneTimePreKeyID + 1;

  try {
    const identityPrivateKey = await importECDHPrivateKeyJWK(identityPrivateKeyJwk);
    const identityPublicKey = await importECDHPublicKeyJWK(identityPublicKeyJwk);
    const signingPrivateKey = await importECDSAPrivateKeyJWK(signingPrivateKeyJwk);
    const signingPublicKey = await importECDSAPublicKeyJWK(signingPublicKeyJwk);

    return {
      userID,
      deviceID: typeof raw.deviceID === 'string' && raw.deviceID.trim() ? raw.deviceID : `device-${userID}`,
      identityPrivateKey,
      identityPublicKey,
      identityPublicKeyJwk,
      signingPrivateKey,
      signingPublicKey,
      signingPublicKeyJwk,
      signedPreKeys: signedPreKeysResolved,
      activeSignedPreKeyID,
      oneTimePreKeys: oneTimePreKeysResolved,
      nextOneTimePreKeyID,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

async function hydrateSessionFromJWK(raw: unknown): Promise<RatchetSessionRecord | null> {
  if (!isObject(raw)) {
    return null;
  }
  const id = typeof raw.id === 'string' ? raw.id : '';
  if (!id) {
    return null;
  }
  const userID = Number(raw.userID);
  const peerUserID = Number(raw.peerUserID);
  if (!Number.isFinite(userID) || userID <= 0 || !Number.isFinite(peerUserID) || peerUserID <= 0) {
    return null;
  }
  const rootKey = typeof raw.rootKey === 'string' ? raw.rootKey : '';
  const sendChainKey = typeof raw.sendChainKey === 'string' ? raw.sendChainKey : '';
  const recvChainKey = typeof raw.recvChainKey === 'string' ? raw.recvChainKey : '';
  const dhSendPublicJwk = isJWKLike(raw.dhSendPublicJwk) ? raw.dhSendPublicJwk : null;
  const dhRecvPublicJwk = isJWKLike(raw.dhRecvPublicJwk) ? raw.dhRecvPublicJwk : null;
  const dhSendPrivateJwk = isJWKLike(raw.dhSendPrivateJwk) ? raw.dhSendPrivateJwk : null;
  const peerIdentityPublicKeyJwk = isJWKLike(raw.peerIdentityPublicKeyJwk)
    ? raw.peerIdentityPublicKeyJwk
    : null;
  const peerIdentitySigningPublicKeyJwk = isJWKLike(raw.peerIdentitySigningPublicKeyJwk)
    ? raw.peerIdentitySigningPublicKeyJwk
    : null;
  if (
    !rootKey ||
    !sendChainKey ||
    !recvChainKey ||
    !dhSendPublicJwk ||
    !dhRecvPublicJwk ||
    !dhSendPrivateJwk ||
    !peerIdentityPublicKeyJwk ||
    !peerIdentitySigningPublicKeyJwk
  ) {
    return null;
  }
  if (
    dhSendPublicJwk.crv !== 'P-256'
    || dhRecvPublicJwk.crv !== 'P-256'
    || dhSendPrivateJwk.crv !== 'P-256'
  ) {
    return null;
  }

  try {
    const dhSendPrivate = await importECDHPrivateKeyJWK(dhSendPrivateJwk);
    return {
      id,
      userID: Math.floor(userID),
      peerUserID: Math.floor(peerUserID),
      status: 'ready',
      rootKey,
      sendChainKey,
      recvChainKey,
      sendCount: Number.isFinite(Number(raw.sendCount)) ? Math.max(0, Math.floor(Number(raw.sendCount))) : 0,
      recvCount: Number.isFinite(Number(raw.recvCount)) ? Math.max(0, Math.floor(Number(raw.recvCount))) : 0,
      previousSendCount: Number.isFinite(Number(raw.previousSendCount))
        ? Math.max(0, Math.floor(Number(raw.previousSendCount)))
        : 0,
      skipped: isObject(raw.skipped)
        ? (Object.fromEntries(
          Object.entries(raw.skipped).filter(
            ([key, value]) => typeof key === 'string' && typeof value === 'string',
          ),
        ) as Record<string, string>)
        : {},
      dhSendPrivate,
      dhSendPublicJwk,
      dhRecvPublicJwk,
      peerIdentityPublicKeyJwk,
      peerIdentitySigningPublicKeyJwk,
      pendingPreKey: normalizePendingPreKey(raw.pendingPreKey),
      isSelfSession: Boolean(raw.isSelfSession),
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

async function serializeIdentityRecordForStorage(record: PersistedIdentityRecord): Promise<Record<string, unknown> | null> {
  const identityPrivateKeyJwk = await exportKeyJWK(record.identityPrivateKey);
  const signingPrivateKeyJwk = await exportKeyJWK(record.signingPrivateKey);
  if (!identityPrivateKeyJwk || !signingPrivateKeyJwk) {
    return null;
  }

  const signedPreKeys: Array<Record<string, unknown>> = [];
  for (const entry of record.signedPreKeys) {
    const privateKeyJwk = await exportKeyJWK(entry.privateKey);
    if (!privateKeyJwk) {
      return null;
    }
    signedPreKeys.push({
      keyID: entry.keyID,
      createdAt: entry.createdAt,
      publicKeyJwk: entry.publicKeyJwk,
      privateKeyJwk,
      signature: entry.signature,
    });
  }

  const oneTimePreKeys: Array<Record<string, unknown>> = [];
  for (const entry of record.oneTimePreKeys) {
    const privateKeyJwk = await exportKeyJWK(entry.privateKey);
    if (!privateKeyJwk) {
      return null;
    }
    oneTimePreKeys.push({
      keyID: entry.keyID,
      createdAt: entry.createdAt,
      publicKeyJwk: entry.publicKeyJwk,
      privateKeyJwk,
    });
  }

  return {
    userID: record.userID,
    deviceID: record.deviceID,
    identityPrivateKeyJwk,
    identityPublicKeyJwk: record.identityPublicKeyJwk,
    signingPrivateKeyJwk,
    signingPublicKeyJwk: record.signingPublicKeyJwk,
    signedPreKeys,
    activeSignedPreKeyID: record.activeSignedPreKeyID,
    oneTimePreKeys,
    nextOneTimePreKeyID: record.nextOneTimePreKeyID,
    updatedAt: record.updatedAt,
  };
}

async function serializeSessionForStorage(record: RatchetSessionRecord): Promise<Record<string, unknown> | null> {
  const dhSendPrivateJwk = await exportKeyJWK(record.dhSendPrivate);
  if (!dhSendPrivateJwk) {
    return null;
  }
  return {
    id: record.id,
    userID: record.userID,
    peerUserID: record.peerUserID,
    rootKey: record.rootKey,
    sendChainKey: record.sendChainKey,
    recvChainKey: record.recvChainKey,
    sendCount: record.sendCount,
    recvCount: record.recvCount,
    previousSendCount: record.previousSendCount,
    skipped: record.skipped,
    dhSendPrivateJwk,
    dhSendPublicJwk: record.dhSendPublicJwk,
    dhRecvPublicJwk: record.dhRecvPublicJwk,
    peerIdentityPublicKeyJwk: record.peerIdentityPublicKeyJwk,
    peerIdentitySigningPublicKeyJwk: record.peerIdentitySigningPublicKeyJwk,
    pendingPreKey: record.pendingPreKey,
    isSelfSession: record.isSelfSession,
    updatedAt: record.updatedAt,
  };
}

export function normalizeSession(raw: unknown): RatchetSessionRecord | null {
  if (!isObject(raw)) {
    return null;
  }
  const id = typeof raw.id === 'string' ? raw.id : '';
  if (!id) {
    return null;
  }
  const userID = Number(raw.userID);
  const peerUserID = Number(raw.peerUserID);
  if (!Number.isFinite(userID) || userID <= 0 || !Number.isFinite(peerUserID) || peerUserID <= 0) {
    return null;
  }
  const rootKey = typeof raw.rootKey === 'string' ? raw.rootKey : '';
  const sendChainKey = typeof raw.sendChainKey === 'string' ? raw.sendChainKey : '';
  const recvChainKey = typeof raw.recvChainKey === 'string' ? raw.recvChainKey : '';
  const dhSendPrivate = isCryptoKey(raw.dhSendPrivate) ? raw.dhSendPrivate : null;
  const dhSendPublicJwk = isObject(raw.dhSendPublicJwk) ? (raw.dhSendPublicJwk as JsonWebKey) : null;
  const dhRecvPublicJwk = isObject(raw.dhRecvPublicJwk) ? (raw.dhRecvPublicJwk as JsonWebKey) : null;
  const peerIdentityPublicKeyJwk = isObject(raw.peerIdentityPublicKeyJwk)
    ? (raw.peerIdentityPublicKeyJwk as JsonWebKey)
    : null;
  const peerIdentitySigningPublicKeyJwk = isObject(raw.peerIdentitySigningPublicKeyJwk)
    ? (raw.peerIdentitySigningPublicKeyJwk as JsonWebKey)
    : null;
  if (!rootKey || !sendChainKey || !recvChainKey || !dhSendPrivate || !dhSendPublicJwk || !dhRecvPublicJwk) {
    return null;
  }
  if (!peerIdentityPublicKeyJwk || !peerIdentitySigningPublicKeyJwk) {
    return null;
  }
  // Invalidate old X25519 sessions — require P-256
  if (dhSendPublicJwk.crv !== 'P-256' || dhRecvPublicJwk.crv !== 'P-256') {
    return null;
  }

  return {
    id,
    userID: Math.floor(userID),
    peerUserID: Math.floor(peerUserID),
    status: 'ready',
    rootKey,
    sendChainKey,
    recvChainKey,
    sendCount: Number.isFinite(Number(raw.sendCount)) ? Math.max(0, Math.floor(Number(raw.sendCount))) : 0,
    recvCount: Number.isFinite(Number(raw.recvCount)) ? Math.max(0, Math.floor(Number(raw.recvCount))) : 0,
    previousSendCount: Number.isFinite(Number(raw.previousSendCount))
      ? Math.max(0, Math.floor(Number(raw.previousSendCount)))
      : 0,
    skipped: isObject(raw.skipped)
      ? (Object.fromEntries(
        Object.entries(raw.skipped).filter(
          ([key, value]) => typeof key === 'string' && typeof value === 'string',
        ),
      ) as Record<string, string>)
      : {},
    dhSendPrivate,
    dhSendPublicJwk,
    dhRecvPublicJwk,
    peerIdentityPublicKeyJwk,
    peerIdentitySigningPublicKeyJwk,
    pendingPreKey: normalizePendingPreKey(raw.pendingPreKey),
    isSelfSession: Boolean(raw.isSelfSession),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
  };
}

export async function readIdentityRecord(userID: number): Promise<PersistedIdentityRecord | null> {
  // Check in-memory cache first
  const cached = identityCache.get(userID);
  if (cached) {
    return cached;
  }
  let db: IDBDatabase;
  try {
    db = await openSecureDB();
  } catch {
    return null;
  }
  try {
    const raw = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(IDENTITY_STORE, 'readonly');
      const request = tx.objectStore(IDENTITY_STORE).get(userID);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('failed to read identity'));
    });
    const result = normalizeIdentityRecord(raw, userID) ?? await hydrateIdentityRecordFromJWK(raw, userID);
    if (result) {
      identityCache.set(userID, result);
    }
    return result;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export async function writeIdentityRecord(record: PersistedIdentityRecord): Promise<void> {
  if (record.userID == null) {
    return;
  }
  // Always update in-memory cache first (survives IDB failures)
  identityCache.set(record.userID, record);
  let db: IDBDatabase;
  try {
    db = await openSecureDB();
  } catch {
    return;
  }
  try {
    const putValue = (value: unknown) => new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDENTITY_STORE, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('failed to write identity'));
      tx.objectStore(IDENTITY_STORE).put(value);
    });
    try {
      await putValue(record);
      return;
    } catch {
      const serialized = await serializeIdentityRecordForStorage(record);
      if (!serialized) {
        return;
      }
      await putValue(serialized);
    }
  } catch {
    // IDB write failed — identity works in-memory for this session
  } finally {
    db.close();
  }
}

export async function readSession(userID: number, peerUserID: number): Promise<RatchetSessionRecord | null> {
  const sessionID = buildSessionID(userID, peerUserID);
  // Check in-memory cache first (protects against IDB write failures)
  const cached = sessionCache.get(sessionID);
  if (cached) {
    return cached;
  }
  let db: IDBDatabase;
  try {
    db = await openSecureDB();
  } catch {
    return null;
  }
  try {
    const raw = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(SESSION_STORE, 'readonly');
      const request = tx.objectStore(SESSION_STORE).get(sessionID);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('failed to read ratchet session'));
    });
    const result = normalizeSession(raw) ?? await hydrateSessionFromJWK(raw);
    if (result) {
      sessionCache.set(sessionID, result);
    }
    return result;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

export async function writeSession(record: RatchetSessionRecord): Promise<void> {
  if (!record.id) {
    return;
  }
  // Always update in-memory cache first (survives IDB failures)
  sessionCache.set(record.id, record);
  let db: IDBDatabase;
  try {
    db = await openSecureDB();
  } catch {
    return;
  }
  try {
    const putValue = (value: unknown) => new Promise<void>((resolve, reject) => {
      const tx = db.transaction(SESSION_STORE, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('failed to write ratchet session'));
      tx.objectStore(SESSION_STORE).put(value);
    });
    try {
      await putValue(record);
      return;
    } catch {
      const serialized = await serializeSessionForStorage(record);
      if (!serialized) {
        return;
      }
      await putValue(serialized);
    }
  } catch {
    // IDB write failed — session works in-memory for this session
  } finally {
    db.close();
  }
}

export async function deleteSession(userID: number, peerUserID: number): Promise<void> {
  const sessionID = buildSessionID(userID, peerUserID);
  sessionCache.delete(sessionID);
  let db: IDBDatabase;
  try {
    db = await openSecureDB();
  } catch {
    return;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(SESSION_STORE, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('failed to delete ratchet session'));
      tx.objectStore(SESSION_STORE).delete(sessionID);
    });
  } catch {
    // Ignore IDB delete failures.
  } finally {
    db.close();
  }
}

export function normalizeIdentityRecord(raw: unknown, userID: number): PersistedIdentityRecord | null {
  if (!isObject(raw)) {
    return null;
  }

  const identityPrivateKey = isCryptoKey(raw.identityPrivateKey) ? raw.identityPrivateKey : null;
  const identityPublicKey = isCryptoKey(raw.identityPublicKey) ? raw.identityPublicKey : null;
  const identityPublicKeyJwk = isObject(raw.identityPublicKeyJwk) ? (raw.identityPublicKeyJwk as JsonWebKey) : null;
  const signingPrivateKey = isCryptoKey(raw.signingPrivateKey) ? raw.signingPrivateKey : null;
  const signingPublicKey = isCryptoKey(raw.signingPublicKey) ? raw.signingPublicKey : null;
  const signingPublicKeyJwk = isObject(raw.signingPublicKeyJwk) ? (raw.signingPublicKeyJwk as JsonWebKey) : null;
  if (!identityPrivateKey || !identityPublicKey || !identityPublicKeyJwk || !signingPrivateKey || !signingPublicKey || !signingPublicKeyJwk) {
    return null;
  }
  // Invalidate old X25519/Ed25519 identities — require P-256
  if (identityPublicKeyJwk.crv !== 'P-256' || signingPublicKeyJwk.crv !== 'P-256') {
    return null;
  }

  const signedPreKeys = normalizeSignedPreKeys(raw.signedPreKeys);
  if (signedPreKeys.length === 0) {
    return null;
  }
  const oneTimePreKeys = normalizeOneTimePreKeys(raw.oneTimePreKeys);

  const activeSignedPreKeyIDRaw = Number(raw.activeSignedPreKeyID);
  const activeSignedPreKey = signedPreKeys.find((entry) => entry.keyID === Math.floor(activeSignedPreKeyIDRaw));
  const activeSignedPreKeyID = activeSignedPreKey
    ? activeSignedPreKey.keyID
    : signedPreKeys[signedPreKeys.length - 1].keyID;

  const nextOneTimePreKeyIDRaw = Number(raw.nextOneTimePreKeyID);
  const maxKnownOneTimePreKeyID = oneTimePreKeys.reduce((max, item) => Math.max(max, item.keyID), 0);
  const nextOneTimePreKeyID = Number.isFinite(nextOneTimePreKeyIDRaw) && nextOneTimePreKeyIDRaw > maxKnownOneTimePreKeyID
    ? Math.floor(nextOneTimePreKeyIDRaw)
    : maxKnownOneTimePreKeyID + 1;

  return {
    userID,
    deviceID: typeof raw.deviceID === 'string' && raw.deviceID.trim() ? raw.deviceID : `device-${userID}`,
    identityPrivateKey,
    identityPublicKey,
    identityPublicKeyJwk,
    signingPrivateKey,
    signingPublicKey,
    signingPublicKeyJwk,
    signedPreKeys,
    activeSignedPreKeyID,
    oneTimePreKeys,
    nextOneTimePreKeyID,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
  };
}
