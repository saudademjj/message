// Outgoing plaintext cache.
//
// Outgoing message plaintext is cached so that the sender can keep reading
// their own messages locally. Persisted records MUST never contain cleartext:
// values are encrypted at rest with a per-user AES-GCM key (mirroring the
// pattern in `secureMessageStore.ts`) and bound to their record identity via
// AAD (`userID:roomID:signature`). The in-memory cache may hold plaintext since
// it is not "at rest".

type OutgoingPlaintextRecord = {
  id: string;
  userID: number;
  roomID: number;
  signature: string;
  plaintext: string;
  createdAtMs: number;
  updatedAtMs: number;
  messageID: number | null;
};

// Shape of the record persisted to IndexedDB. It only ever stores ciphertext
// plus the IV; the plaintext lives exclusively in memory.
type PersistedOutgoingRecord = {
  id: string;
  userID: number;
  roomID: number;
  signature: string;
  iv: string;
  ciphertext: string;
  createdAtMs: number;
  updatedAtMs: number;
  messageID: number | null;
};

type CacheKeyRecord = {
  userID: number;
  key?: CryptoKey;
  keyRawB64?: string;
  createdAt: string;
};

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_MAX_SIZE = 1200;
const DB_NAME = 'e2ee-chat-outgoing-plaintext-cache';
const DB_VERSION = 2;
const OUTGOING_STORE = 'outgoing';
const KEY_STORE = 'keys';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const outgoingPlaintextCache = new Map<string, OutgoingPlaintextRecord>();
const userKeyCache = new Map<number, CryptoKey>();
const pendingUserKeyLoads = new Map<number, Promise<CryptoKey | null>>();

function buildCacheKey(userID: number, roomID: number, signature: string): string {
  return `${userID}:${roomID}:${signature}`;
}

function hasSecureStoreSupport(): boolean {
  return Boolean(
    typeof window !== 'undefined'
    && window.isSecureContext
    && typeof crypto !== 'undefined'
    && crypto.subtle
    && typeof window.indexedDB !== 'undefined',
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCryptoKey(value: unknown): value is CryptoKey {
  return typeof CryptoKey !== 'undefined' && value instanceof CryptoKey;
}

function toBase64(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function fromBase64(input: string): ArrayBuffer {
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function buildOutgoingAAD(userID: number, roomID: number, signature: string): ArrayBuffer {
  const encoded = encoder.encode(`${userID}:${roomID}:${signature}`);
  const copy = new Uint8Array(encoded.byteLength);
  copy.set(encoded);
  return copy.buffer;
}

function isValidLookup(userID: number, roomID: number, signature: string): boolean {
  const normalizedSignature = signature.trim();
  return (
    Number.isFinite(userID)
    && userID > 0
    && Number.isFinite(roomID)
    && roomID > 0
    && Boolean(normalizedSignature)
  );
}

function normalizePersistedRecord(raw: unknown): PersistedOutgoingRecord | null {
  if (!isObject(raw)) {
    return null;
  }
  const typed = raw as Partial<PersistedOutgoingRecord>;
  if (
    typeof typed.id !== 'string'
    || !Number.isFinite(typed.userID)
    || !Number.isFinite(typed.roomID)
    || typeof typed.signature !== 'string'
    || typeof typed.iv !== 'string'
    || typeof typed.ciphertext !== 'string'
    || !Number.isFinite(typed.createdAtMs)
    || !Number.isFinite(typed.updatedAtMs)
  ) {
    return null;
  }
  return {
    id: typed.id,
    userID: Number(typed.userID),
    roomID: Number(typed.roomID),
    signature: typed.signature,
    iv: typed.iv,
    ciphertext: typed.ciphertext,
    createdAtMs: Number(typed.createdAtMs),
    updatedAtMs: Number(typed.updatedAtMs),
    messageID: Number.isFinite(typed.messageID) ? Number(typed.messageID) : null,
  };
}

function normalizeCacheKeyRecord(raw: unknown): CacheKeyRecord | null {
  if (!isObject(raw) || !Number.isFinite(Number(raw.userID))) {
    return null;
  }
  const key = isCryptoKey(raw.key) ? raw.key : undefined;
  const keyRawB64 = typeof raw.keyRawB64 === 'string' && raw.keyRawB64.trim()
    ? raw.keyRawB64.trim()
    : undefined;
  if (!key && !keyRawB64) {
    return null;
  }
  return {
    userID: Number(raw.userID),
    key,
    keyRawB64,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
  };
}

async function openOutgoingDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      // The v1 schema persisted plaintext. Drop that store on upgrade so no
      // legacy cleartext lingers; it is recreated empty below.
      if (event.oldVersion < 2 && db.objectStoreNames.contains(OUTGOING_STORE)) {
        db.deleteObjectStore(OUTGOING_STORE);
      }
      if (!db.objectStoreNames.contains(OUTGOING_STORE)) {
        db.createObjectStore(OUTGOING_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(KEY_STORE)) {
        db.createObjectStore(KEY_STORE, { keyPath: 'userID' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('failed to open outgoing plaintext db'));
  });
}

async function importCacheKeyFromRawB64(rawB64: string): Promise<CryptoKey | null> {
  try {
    return await crypto.subtle.importKey(
      'raw',
      fromBase64(rawB64),
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt'],
    );
  } catch {
    return null;
  }
}

async function exportCacheKeyToRawB64(key: CryptoKey): Promise<string | null> {
  try {
    const raw = await crypto.subtle.exportKey('raw', key);
    return toBase64(raw);
  } catch {
    return null;
  }
}

async function readUserKeyFromDB(db: IDBDatabase, userID: number): Promise<CryptoKey | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KEY_STORE, 'readonly');
    const request = tx.objectStore(KEY_STORE).get(userID);
    request.onsuccess = () => void (async () => {
      const record = normalizeCacheKeyRecord(request.result);
      if (!record) {
        resolve(null);
        return;
      }
      if (record.key) {
        resolve(record.key);
        return;
      }
      if (record.keyRawB64) {
        resolve(await importCacheKeyFromRawB64(record.keyRawB64));
        return;
      }
      resolve(null);
    })();
    request.onerror = () => reject(request.error ?? new Error('failed to read outgoing cache key'));
  });
}

async function writeUserKeyToDB(db: IDBDatabase, userID: number, key: CryptoKey): Promise<void> {
  const putValue = (value: CacheKeyRecord) => new Promise<void>((resolve, reject) => {
    const tx = db.transaction(KEY_STORE, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('failed to store outgoing cache key'));
    tx.objectStore(KEY_STORE).put(value);
  });
  try {
    try {
      await putValue({ userID, key, createdAt: new Date().toISOString() });
      return;
    } catch {
      const keyRawB64 = await exportCacheKeyToRawB64(key);
      if (!keyRawB64) {
        return;
      }
      await putValue({ userID, keyRawB64, createdAt: new Date().toISOString() });
    }
  } catch {
    // IDB write failed — caching simply degrades for this session.
  }
}

async function getUserCacheKey(userID: number, createIfMissing: boolean): Promise<CryptoKey | null> {
  if (!hasSecureStoreSupport() || !Number.isFinite(userID) || userID <= 0) {
    return null;
  }
  const cached = userKeyCache.get(userID);
  if (cached) {
    return cached;
  }

  const pending = pendingUserKeyLoads.get(userID);
  if (pending) {
    const resolved = await pending;
    if (resolved || !createIfMissing) {
      return resolved;
    }
  }

  const nextPromise = (async () => {
    const db = await openOutgoingDB();
    try {
      const existing = await readUserKeyFromDB(db, userID);
      if (existing) {
        userKeyCache.set(userID, existing);
        return existing;
      }
      if (!createIfMissing) {
        return null;
      }
      const generated = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt'],
      );
      if (!isCryptoKey(generated)) {
        return null;
      }
      await writeUserKeyToDB(db, userID, generated);
      userKeyCache.set(userID, generated);
      return generated;
    } finally {
      db.close();
    }
  })();

  pendingUserKeyLoads.set(userID, nextPromise);
  try {
    return await nextPromise;
  } catch {
    return null;
  } finally {
    if (pendingUserKeyLoads.get(userID) === nextPromise) {
      pendingUserKeyLoads.delete(userID);
    }
  }
}

function pruneCache(nowMs: number): void {
  for (const [key, record] of outgoingPlaintextCache.entries()) {
    if (nowMs - record.updatedAtMs > CACHE_TTL_MS) {
      outgoingPlaintextCache.delete(key);
    }
  }
  if (outgoingPlaintextCache.size <= CACHE_MAX_SIZE) {
    return;
  }
  const ordered = [...outgoingPlaintextCache.entries()]
    .sort((left, right) => left[1].updatedAtMs - right[1].updatedAtMs);
  const removeCount = outgoingPlaintextCache.size - CACHE_MAX_SIZE;
  for (let index = 0; index < removeCount; index += 1) {
    outgoingPlaintextCache.delete(ordered[index][0]);
  }
}

async function readPersistedRecord(id: string): Promise<PersistedOutgoingRecord | null> {
  if (!hasSecureStoreSupport()) {
    return null;
  }
  let db: IDBDatabase;
  try {
    db = await openOutgoingDB();
  } catch {
    return null;
  }
  try {
    const raw = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(OUTGOING_STORE, 'readonly');
      const request = tx.objectStore(OUTGOING_STORE).get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('failed to read outgoing plaintext'));
    });
    return normalizePersistedRecord(raw);
  } catch {
    return null;
  } finally {
    db.close();
  }
}

async function readDecryptedRecordFromDB(
  userID: number,
  roomID: number,
  signature: string,
): Promise<OutgoingPlaintextRecord | null> {
  const persisted = await readPersistedRecord(buildCacheKey(userID, roomID, signature));
  if (!persisted) {
    return null;
  }
  const encryptionKey = await getUserCacheKey(userID, false);
  if (!encryptionKey) {
    return null;
  }
  let plaintext: string;
  try {
    const decrypted = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: fromBase64(persisted.iv),
        additionalData: buildOutgoingAAD(userID, roomID, signature),
      },
      encryptionKey,
      fromBase64(persisted.ciphertext),
    );
    plaintext = decoder.decode(decrypted);
  } catch {
    return null;
  }
  return {
    id: persisted.id,
    userID: persisted.userID,
    roomID: persisted.roomID,
    signature: persisted.signature,
    plaintext,
    createdAtMs: persisted.createdAtMs,
    updatedAtMs: persisted.updatedAtMs,
    messageID: persisted.messageID,
  };
}

async function writePersistedRecord(record: PersistedOutgoingRecord): Promise<void> {
  if (!hasSecureStoreSupport()) {
    return;
  }
  let db: IDBDatabase;
  try {
    db = await openOutgoingDB();
  } catch {
    return;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(OUTGOING_STORE, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('failed to write outgoing plaintext'));
      tx.objectStore(OUTGOING_STORE).put(record);
    });
  } catch {
    // Ignore IDB failures, memory cache still works for this session.
  } finally {
    db.close();
  }
}

async function writeRecordToDB(record: OutgoingPlaintextRecord): Promise<void> {
  const encryptionKey = await getUserCacheKey(record.userID, true);
  if (!encryptionKey) {
    // Fail safe: without Web Crypto we never persist plaintext.
    return;
  }
  let iv: string;
  let ciphertext: string;
  try {
    const ivBytes = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: ivBytes,
        additionalData: buildOutgoingAAD(record.userID, record.roomID, record.signature),
      },
      encryptionKey,
      encoder.encode(record.plaintext),
    );
    iv = toBase64(ivBytes);
    ciphertext = toBase64(encrypted);
  } catch {
    return;
  }
  await writePersistedRecord({
    id: record.id,
    userID: record.userID,
    roomID: record.roomID,
    signature: record.signature,
    iv,
    ciphertext,
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
    messageID: record.messageID,
  });
}

async function prunePersistentStore(nowMs: number): Promise<void> {
  if (!hasSecureStoreSupport()) {
    return;
  }
  let db: IDBDatabase;
  try {
    db = await openOutgoingDB();
  } catch {
    return;
  }
  try {
    const records = await new Promise<PersistedOutgoingRecord[]>((resolve, reject) => {
      const tx = db.transaction(OUTGOING_STORE, 'readonly');
      const request = tx.objectStore(OUTGOING_STORE).getAll();
      request.onsuccess = () => {
        const values = Array.isArray(request.result) ? request.result : [];
        const normalized = values
          .map((value) => normalizePersistedRecord(value))
          .filter((item): item is PersistedOutgoingRecord => Boolean(item));
        resolve(normalized);
      };
      request.onerror = () => reject(request.error ?? new Error('failed to list outgoing plaintext records'));
    });
    const expiredIDs = records
      .filter((record) => nowMs - record.updatedAtMs > CACHE_TTL_MS)
      .map((record) => record.id);
    const valid = records.filter((record) => nowMs - record.updatedAtMs <= CACHE_TTL_MS);
    const overflow = Math.max(0, valid.length - CACHE_MAX_SIZE);
    const overflowIDs = overflow <= 0
      ? []
      : valid
        .sort((left, right) => left.updatedAtMs - right.updatedAtMs)
        .slice(0, overflow)
        .map((record) => record.id);
    const idsToDelete = [...new Set([...expiredIDs, ...overflowIDs])];
    if (idsToDelete.length === 0) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(OUTGOING_STORE, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('failed to prune outgoing plaintext records'));
      const store = tx.objectStore(OUTGOING_STORE);
      for (const id of idsToDelete) {
        store.delete(id);
      }
    });
  } catch {
    // Ignore pruning failures.
  } finally {
    db.close();
  }
}

async function deleteRecordFromDB(id: string): Promise<void> {
  if (!hasSecureStoreSupport()) {
    return;
  }
  let db: IDBDatabase;
  try {
    db = await openOutgoingDB();
  } catch {
    return;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(OUTGOING_STORE, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('failed to delete outgoing plaintext'));
      tx.objectStore(OUTGOING_STORE).delete(id);
    });
  } catch {
    // Ignore IDB delete failures.
  } finally {
    db.close();
  }
}

export async function rememberOutgoingPlaintext(
  userID: number,
  roomID: number,
  signature: string,
  plaintext: string,
): Promise<void> {
  const normalizedSignature = signature.trim();
  if (!isValidLookup(userID, roomID, normalizedSignature) || !plaintext) {
    return;
  }
  const nowMs = Date.now();
  const key = buildCacheKey(userID, roomID, normalizedSignature);
  pruneCache(nowMs);
  const nextRecord: OutgoingPlaintextRecord = {
    id: key,
    userID,
    roomID,
    signature: normalizedSignature,
    plaintext,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    messageID: null,
  };
  const previous = outgoingPlaintextCache.get(key);
  if (previous) {
    nextRecord.createdAtMs = previous.createdAtMs;
    nextRecord.messageID = previous.messageID;
  }
  outgoingPlaintextCache.set(key, nextRecord);
  await writeRecordToDB(nextRecord);
  await prunePersistentStore(nowMs);
}

export async function markOutgoingPlaintextDelivered(
  userID: number,
  roomID: number,
  signature: string,
  messageID: number,
): Promise<void> {
  const normalizedSignature = signature.trim();
  if (!isValidLookup(userID, roomID, normalizedSignature) || !Number.isFinite(messageID) || messageID <= 0) {
    return;
  }
  const key = buildCacheKey(userID, roomID, normalizedSignature);
  const nowMs = Date.now();
  const fromMemory = outgoingPlaintextCache.get(key);
  if (fromMemory) {
    fromMemory.messageID = messageID;
    fromMemory.updatedAtMs = nowMs;
    outgoingPlaintextCache.set(key, fromMemory);
    await writeRecordToDB(fromMemory);
    return;
  }
  const fromDB = await readDecryptedRecordFromDB(userID, roomID, normalizedSignature);
  if (!fromDB) {
    return;
  }
  fromDB.messageID = messageID;
  fromDB.updatedAtMs = nowMs;
  outgoingPlaintextCache.set(key, fromDB);
  pruneCache(nowMs);
  await writeRecordToDB(fromDB);
}

export async function readOutgoingPlaintext(
  userID: number,
  roomID: number,
  signature: string,
): Promise<string | null> {
  const normalizedSignature = signature.trim();
  if (!isValidLookup(userID, roomID, normalizedSignature)) {
    return null;
  }
  const nowMs = Date.now();
  pruneCache(nowMs);
  const key = buildCacheKey(userID, roomID, normalizedSignature);
  const fromMemory = outgoingPlaintextCache.get(key);
  if (fromMemory) {
    if (nowMs - fromMemory.updatedAtMs > CACHE_TTL_MS) {
      outgoingPlaintextCache.delete(key);
      await deleteRecordFromDB(key);
      return null;
    }
    return fromMemory.plaintext;
  }

  const fromDB = await readDecryptedRecordFromDB(userID, roomID, normalizedSignature);
  if (!fromDB) {
    return null;
  }
  if (nowMs - fromDB.updatedAtMs > CACHE_TTL_MS) {
    await deleteRecordFromDB(key);
    return null;
  }
  outgoingPlaintextCache.set(key, fromDB);
  pruneCache(nowMs);
  return fromDB.plaintext;
}

export async function __resetOutgoingPlaintextCacheForTests(
  options: { clearPersistent?: boolean } = {},
): Promise<void> {
  outgoingPlaintextCache.clear();
  if (!options.clearPersistent) {
    return;
  }
  userKeyCache.clear();
  pendingUserKeyLoads.clear();
  if (typeof window === 'undefined' || typeof window.indexedDB === 'undefined') {
    return;
  }
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}
