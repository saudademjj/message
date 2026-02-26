import type { ChatMessage } from './types';

const MESSAGE_DB_NAME = 'e2ee-chat-message-cache';
const MESSAGE_DB_VERSION = 1;
const MESSAGE_STORE = 'messages';
const KEY_STORE = 'keys';

type MessageKeyRecord = {
  userID: number;
  key?: CryptoKey;
  keyRawB64?: string;
  createdAt: string;
};

type MessageRecord = {
  id: string;
  userID: number;
  roomID: number;
  messageID: number;
  senderID: number;
  createdAt: string;
  iv: string;
  ciphertext: string;
  storedAt: string;
};

type MessageSnapshot = Pick<ChatMessage, 'id' | 'roomId' | 'senderId' | 'createdAt'>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const userKeyCache = new Map<number, CryptoKey>();
const pendingUserKeyLoads = new Map<number, Promise<CryptoKey | null>>();

function hasSecureStoreSupport(): boolean {
  return Boolean(window.isSecureContext && crypto?.subtle && window.indexedDB);
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

function buildMessageRecordID(userID: number, messageID: number): string {
  return `${userID}:${messageID}`;
}

function buildAAD(userID: number, message: MessageSnapshot): ArrayBuffer {
  const encoded = encoder.encode(
    `${userID}|${message.id}|${message.roomId}|${message.senderId}|${message.createdAt}`,
  );
  const copy = new Uint8Array(encoded.byteLength);
  copy.set(encoded);
  return copy.buffer;
}

function normalizeMessageRecord(raw: unknown): MessageRecord | null {
  if (!isObject(raw)) {
    return null;
  }
  if (
    typeof raw.id !== 'string' ||
    !Number.isFinite(Number(raw.userID)) ||
    !Number.isFinite(Number(raw.roomID)) ||
    !Number.isFinite(Number(raw.messageID)) ||
    !Number.isFinite(Number(raw.senderID)) ||
    typeof raw.createdAt !== 'string' ||
    typeof raw.iv !== 'string' ||
    typeof raw.ciphertext !== 'string'
  ) {
    return null;
  }
  return {
    id: raw.id,
    userID: Number(raw.userID),
    roomID: Number(raw.roomID),
    messageID: Number(raw.messageID),
    senderID: Number(raw.senderID),
    createdAt: raw.createdAt,
    iv: raw.iv,
    ciphertext: raw.ciphertext,
    storedAt: typeof raw.storedAt === 'string' ? raw.storedAt : new Date().toISOString(),
  };
}

function normalizeMessageKeyRecord(raw: unknown): MessageKeyRecord | null {
  if (!isObject(raw)) {
    return null;
  }
  if (!Number.isFinite(Number(raw.userID))) {
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

async function importMessageKeyFromRawB64(rawB64: string): Promise<CryptoKey | null> {
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

async function exportMessageKeyToRawB64(key: CryptoKey): Promise<string | null> {
  try {
    const raw = await crypto.subtle.exportKey('raw', key);
    return toBase64(raw);
  } catch {
    return null;
  }
}

async function openMessageDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(MESSAGE_DB_NAME, MESSAGE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(KEY_STORE)) {
        db.createObjectStore(KEY_STORE, { keyPath: 'userID' });
      }
      if (!db.objectStoreNames.contains(MESSAGE_STORE)) {
        db.createObjectStore(MESSAGE_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('failed to open local message cache'));
  });
}

async function readUserKeyFromDB(db: IDBDatabase, userID: number): Promise<CryptoKey | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KEY_STORE, 'readonly');
    const request = tx.objectStore(KEY_STORE).get(userID);
    request.onsuccess = () => void (async () => {
      const record = normalizeMessageKeyRecord(request.result);
      if (!record) {
        resolve(null);
        return;
      }
      if (record.key) {
        resolve(record.key);
        return;
      }
      if (record.keyRawB64) {
        resolve(await importMessageKeyFromRawB64(record.keyRawB64));
        return;
      }
      resolve(null);
    })();
    request.onerror = () => reject(request.error ?? new Error('failed to read local message key'));
  });
}

async function writeUserKeyToDB(db: IDBDatabase, userID: number, key: CryptoKey): Promise<void> {
  const putValue = (value: MessageKeyRecord) => new Promise<void>((resolve, reject) => {
    const tx = db.transaction(KEY_STORE, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('failed to store local message key'));
    tx.objectStore(KEY_STORE).put(value);
  });
  try {
    try {
      await putValue({
        userID,
        key,
        createdAt: new Date().toISOString(),
      });
      return;
    } catch {
      const keyRawB64 = await exportMessageKeyToRawB64(key);
      if (!keyRawB64) {
        return;
      }
      await putValue({
        userID,
        keyRawB64,
        createdAt: new Date().toISOString(),
      });
    }
  } catch {
    // IDB write failed — key cache miss is acceptable
  }
}

async function getUserMessageKey(userID: number, createIfMissing: boolean): Promise<CryptoKey | null> {
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
    const db = await openMessageDB();
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
        throw new Error('failed to create local message cache key');
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
  } finally {
    if (pendingUserKeyLoads.get(userID) === nextPromise) {
      pendingUserKeyLoads.delete(userID);
    }
  }
}

async function writeMessageRecord(record: MessageRecord): Promise<void> {
  if (!record.id) {
    return;
  }
  let db: IDBDatabase;
  try {
    db = await openMessageDB();
  } catch {
    return;
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(MESSAGE_STORE, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('failed to persist local message cache'));
      tx.objectStore(MESSAGE_STORE).put(record);
    });
  } catch {
    // IDB write failed — message cache miss is acceptable
  } finally {
    db.close();
  }
}

async function readMessageRecords(userID: number, messageIDs: number[]): Promise<Map<number, MessageRecord>> {
  if (messageIDs.length === 0) {
    return new Map();
  }

  const db = await openMessageDB();
  try {
    const tx = db.transaction(MESSAGE_STORE, 'readonly');
    const store = tx.objectStore(MESSAGE_STORE);
    const records = await Promise.all(
      messageIDs.map(
        (messageID) =>
          new Promise<MessageRecord | null>((resolve, reject) => {
            const request = store.get(buildMessageRecordID(userID, messageID));
            request.onsuccess = () => resolve(normalizeMessageRecord(request.result));
            request.onerror = () => reject(request.error ?? new Error('failed to read local message cache'));
          }),
      ),
    );
    const mapped = new Map<number, MessageRecord>();
    for (const record of records) {
      if (record) {
        mapped.set(record.messageID, record);
      }
    }
    return mapped;
  } finally {
    db.close();
  }
}

function isValidPositiveInt(value: unknown): value is number {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function normalizeMessages(messages: MessageSnapshot[]): MessageSnapshot[] {
  const seen = new Set<number>();
  const normalized: MessageSnapshot[] = [];
  for (const message of messages) {
    if (
      !isValidPositiveInt(message.id) ||
      !isValidPositiveInt(message.roomId) ||
      !isValidPositiveInt(message.senderId) ||
      typeof message.createdAt !== 'string'
    ) {
      continue;
    }
    if (seen.has(message.id)) {
      continue;
    }
    seen.add(message.id);
    normalized.push(message);
  }
  return normalized;
}

export async function persistDecryptedPlaintext(
  userID: number,
  message: MessageSnapshot,
  plaintext: string,
): Promise<void> {
  if (!hasSecureStoreSupport()) {
    return;
  }
  if (!isValidPositiveInt(userID)) {
    return;
  }

  const normalized = normalizeMessages([message])[0];
  if (!normalized) {
    return;
  }

  const key = await getUserMessageKey(userID, true);
  if (!key) {
    return;
  }

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: buildAAD(userID, normalized),
    },
    key,
    encoder.encode(plaintext),
  );

  await writeMessageRecord({
    id: buildMessageRecordID(userID, normalized.id),
    userID,
    roomID: normalized.roomId,
    messageID: normalized.id,
    senderID: normalized.senderId,
    createdAt: normalized.createdAt,
    iv: toBase64(iv),
    ciphertext: toBase64(encrypted),
    storedAt: new Date().toISOString(),
  });
}

export async function loadCachedPlaintexts(
  userID: number,
  messages: MessageSnapshot[],
): Promise<Map<number, string>> {
  const plaintexts = new Map<number, string>();
  if (!hasSecureStoreSupport()) {
    return plaintexts;
  }
  if (!isValidPositiveInt(userID)) {
    return plaintexts;
  }

  const normalized = normalizeMessages(messages);
  if (normalized.length === 0) {
    return plaintexts;
  }

  const key = await getUserMessageKey(userID, false);
  if (!key) {
    return plaintexts;
  }

  const records = await readMessageRecords(userID, normalized.map((message) => message.id));
  for (const message of normalized) {
    const record = records.get(message.id);
    if (!record) {
      continue;
    }
    try {
      const decrypted = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: fromBase64(record.iv),
          additionalData: buildAAD(userID, message),
        },
        key,
        fromBase64(record.ciphertext),
      );
      plaintexts.set(message.id, decoder.decode(decrypted));
    } catch {
      // Skip corrupted or mismatched cache records.
    }
  }
  return plaintexts;
}
