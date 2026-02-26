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

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_MAX_SIZE = 1200;
const DB_NAME = 'e2ee-chat-outgoing-plaintext-cache';
const DB_VERSION = 1;
const OUTGOING_STORE = 'outgoing';
const outgoingPlaintextCache = new Map<string, OutgoingPlaintextRecord>();

function buildCacheKey(userID: number, roomID: number, signature: string): string {
  return `${userID}:${roomID}:${signature}`;
}

function hasIndexedDBSupport(): boolean {
  return typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';
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

async function openOutgoingDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(OUTGOING_STORE)) {
        db.createObjectStore(OUTGOING_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('failed to open outgoing plaintext db'));
  });
}

async function readRecordFromDB(id: string): Promise<OutgoingPlaintextRecord | null> {
  if (!hasIndexedDBSupport()) {
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
    if (typeof raw !== 'object' || raw === null) {
      return null;
    }
    const typed = raw as Partial<OutgoingPlaintextRecord>;
    if (
      typeof typed.id !== 'string'
      || !Number.isFinite(typed.userID)
      || !Number.isFinite(typed.roomID)
      || typeof typed.signature !== 'string'
      || typeof typed.plaintext !== 'string'
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
      plaintext: typed.plaintext,
      createdAtMs: Number(typed.createdAtMs),
      updatedAtMs: Number(typed.updatedAtMs),
      messageID: Number.isFinite(typed.messageID) ? Number(typed.messageID) : null,
    };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

async function writeRecordToDB(record: OutgoingPlaintextRecord): Promise<void> {
  if (!hasIndexedDBSupport()) {
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

async function prunePersistentStore(nowMs: number): Promise<void> {
  if (!hasIndexedDBSupport()) {
    return;
  }
  let db: IDBDatabase;
  try {
    db = await openOutgoingDB();
  } catch {
    return;
  }
  try {
    const records = await new Promise<OutgoingPlaintextRecord[]>((resolve, reject) => {
      const tx = db.transaction(OUTGOING_STORE, 'readonly');
      const request = tx.objectStore(OUTGOING_STORE).getAll();
      request.onsuccess = () => {
        const values = Array.isArray(request.result) ? request.result : [];
        const normalized = values
          .map((value) => {
            if (typeof value !== 'object' || value === null) {
              return null;
            }
            const typed = value as Partial<OutgoingPlaintextRecord>;
            if (
              typeof typed.id !== 'string'
              || !Number.isFinite(typed.userID)
              || !Number.isFinite(typed.roomID)
              || typeof typed.signature !== 'string'
              || typeof typed.plaintext !== 'string'
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
              plaintext: typed.plaintext,
              createdAtMs: Number(typed.createdAtMs),
              updatedAtMs: Number(typed.updatedAtMs),
              messageID: Number.isFinite(typed.messageID) ? Number(typed.messageID) : null,
            } satisfies OutgoingPlaintextRecord;
          })
          .filter((item): item is OutgoingPlaintextRecord => Boolean(item));
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
  if (!hasIndexedDBSupport()) {
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
  const fromDB = await readRecordFromDB(key);
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

  const fromDB = await readRecordFromDB(key);
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
  if (!options.clearPersistent || !hasIndexedDBSupport()) {
    return;
  }
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}
