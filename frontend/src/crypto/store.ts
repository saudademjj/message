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

const SECURE_STORE_UNAVAILABLE_MESSAGE = '本地安全密钥存储不可用，请刷新页面后重新登录';
const SECURE_STORE_READ_FAILED_MESSAGE = '本地安全密钥读取失败，请刷新页面后重新登录';
const SECURE_STORE_WRITE_FAILED_MESSAGE = '本地安全密钥持久化失败，请刷新页面后重新登录';

function toSecureStoreError(reason: unknown, fallback: string): Error {
  if (reason instanceof Error && reason.message.trim()) {
    return new Error(`${fallback} (${reason.message.trim()})`);
  }
  return new Error(fallback);
}

function openSecureDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('IndexedDB open timeout (5s)'));
    }, 5000);
    let settled = false;
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
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(request.result);
    };
    request.onerror = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(request.error ?? new Error('failed to open secure store'));
    };
  });
}

function normalizePendingPreKey(raw: unknown): PendingPreKeyState | null {
  if (!isObject(raw)) {
    return null;
  }
  const signedPreKeyID = Number(raw.signedPreKeyId);
  if (!Number.isFinite(signedPreKeyID) || signedPreKeyID <= 0) {
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
  const oneTimePreKeyIDRaw = raw.oneTimePreKeyId;
  const oneTimePreKeyID = oneTimePreKeyIDRaw == null
    ? null
    : Number.isFinite(Number(oneTimePreKeyIDRaw)) && Number(oneTimePreKeyIDRaw) > 0
      ? Math.floor(Number(oneTimePreKeyIDRaw))
      : null;
  return {
    identityKeyJwk,
    identitySigningPublicKeyJwk,
    ephemeralKeyJwk,
    signedPreKeyId: Math.floor(signedPreKeyID),
    oneTimePreKeyId: oneTimePreKeyID,
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

export async function readIdentityRecord(userID: number): Promise<PersistedIdentityRecord | null> {
  let db: IDBDatabase;
  try {
    db = await openSecureDB();
  } catch (reason: unknown) {
    throw toSecureStoreError(reason, SECURE_STORE_UNAVAILABLE_MESSAGE);
  }

  try {
    const raw = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(IDENTITY_STORE, 'readonly');
      const request = tx.objectStore(IDENTITY_STORE).get(userID);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('failed to read identity'));
    });
    return normalizeIdentityRecord(raw, userID);
  } catch (reason: unknown) {
    throw toSecureStoreError(reason, SECURE_STORE_READ_FAILED_MESSAGE);
  } finally {
    db.close();
  }
}

export async function writeIdentityRecord(record: PersistedIdentityRecord): Promise<void> {
  if (record.userID == null) {
    throw new Error(SECURE_STORE_WRITE_FAILED_MESSAGE);
  }

  let db: IDBDatabase;
  try {
    db = await openSecureDB();
  } catch (reason: unknown) {
    throw toSecureStoreError(reason, SECURE_STORE_UNAVAILABLE_MESSAGE);
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDENTITY_STORE, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('failed to write identity'));
      tx.objectStore(IDENTITY_STORE).put(record);
    });
  } catch (reason: unknown) {
    throw toSecureStoreError(reason, SECURE_STORE_WRITE_FAILED_MESSAGE);
  } finally {
    db.close();
  }
}

export async function readSession(
  userID: number,
  localDeviceID: string,
  peerUserID: number,
  peerDeviceID: string,
): Promise<RatchetSessionRecord | null> {
  const sessionID = buildSessionID(userID, localDeviceID, peerUserID, peerDeviceID);

  let db: IDBDatabase;
  try {
    db = await openSecureDB();
  } catch (reason: unknown) {
    throw toSecureStoreError(reason, SECURE_STORE_UNAVAILABLE_MESSAGE);
  }

  try {
    const raw = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(SESSION_STORE, 'readonly');
      const request = tx.objectStore(SESSION_STORE).get(sessionID);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('failed to read ratchet session'));
    });
    return normalizeSession(raw);
  } catch (reason: unknown) {
    throw toSecureStoreError(reason, SECURE_STORE_READ_FAILED_MESSAGE);
  } finally {
    db.close();
  }
}

export async function writeSession(record: RatchetSessionRecord): Promise<void> {
  if (!record.id) {
    throw new Error(SECURE_STORE_WRITE_FAILED_MESSAGE);
  }

  let db: IDBDatabase;
  try {
    db = await openSecureDB();
  } catch (reason: unknown) {
    throw toSecureStoreError(reason, SECURE_STORE_UNAVAILABLE_MESSAGE);
  }

  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(SESSION_STORE, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('failed to write ratchet session'));
      tx.objectStore(SESSION_STORE).put(record);
    });
  } catch (reason: unknown) {
    throw toSecureStoreError(reason, SECURE_STORE_WRITE_FAILED_MESSAGE);
  } finally {
    db.close();
  }
}

export async function deleteSession(
  userID: number,
  localDeviceID: string,
  peerUserID: number,
  peerDeviceID: string,
): Promise<void> {
  const sessionID = buildSessionID(userID, localDeviceID, peerUserID, peerDeviceID);
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
    // Ignore delete failures.
  } finally {
    db.close();
  }
}

export async function deleteAllSessionsForUser(userID: number): Promise<void> {
  const userPrefix = `${Math.floor(userID)}:`;
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
      tx.onerror = () => reject(tx.error ?? new Error('failed to clear user sessions'));
      const store = tx.objectStore(SESSION_STORE);
      const cursorRequest = store.openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) {
          return;
        }
        const candidate = cursor.value as { id?: unknown; userID?: unknown };
        const cursorID = typeof candidate?.id === 'string' ? candidate.id : '';
        const cursorUserID = Number(candidate?.userID);
        if (
          (Number.isFinite(cursorUserID) && Math.floor(cursorUserID) === Math.floor(userID))
          || cursorID.startsWith(userPrefix)
        ) {
          cursor.delete();
        }
        cursor.continue();
      };
      cursorRequest.onerror = () => {
        reject(cursorRequest.error ?? new Error('failed to iterate session store'));
      };
    });
  } catch {
    // Ignore cleanup failures.
  } finally {
    db.close();
  }
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
  const localDeviceID = typeof raw.localDeviceID === 'string' && raw.localDeviceID.trim()
    ? raw.localDeviceID.trim()
    : 'legacy-local';
  const peerUserID = Number(raw.peerUserID);
  const peerDeviceID = typeof raw.peerDeviceID === 'string' && raw.peerDeviceID.trim()
    ? raw.peerDeviceID.trim()
    : 'legacy-peer';
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
  if (dhSendPublicJwk.crv !== 'P-256' || dhRecvPublicJwk.crv !== 'P-256') {
    return null;
  }

  return {
    id,
    userID: Math.floor(userID),
    localDeviceID,
    peerUserID: Math.floor(peerUserID),
    peerDeviceID,
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
