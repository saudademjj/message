type ResyncDedupeSnapshot = Record<string, number>;

const STORAGE_KEY = 'e2ee-chat:resync-recovery-dedupe:v1';
const COOLDOWN_MS = 2 * 60 * 1000;
const MAX_ENTRIES = 3000;

const dedupeCache = new Map<string, number>();
let loaded = false;

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function buildKey(userID: number, roomID: number, senderUserID: number, messageID: number): string {
  return `${userID}:${roomID}:${senderUserID}:${messageID}`;
}

function loadFromStorage(): void {
  if (loaded || !canUseStorage()) {
    loaded = true;
    return;
  }
  loaded = true;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return;
    }
    const parsed = JSON.parse(raw) as ResyncDedupeSnapshot;
    if (!parsed || typeof parsed !== 'object') {
      return;
    }
    for (const [key, value] of Object.entries(parsed)) {
      if (Number.isFinite(value) && value > 0) {
        dedupeCache.set(key, Number(value));
      }
    }
  } catch {
    // Ignore storage read failures.
  }
}

function persistToStorage(): void {
  if (!canUseStorage()) {
    return;
  }
  try {
    const snapshot = Object.fromEntries(dedupeCache.entries());
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // Ignore storage write failures.
  }
}

function prune(nowMs: number): void {
  for (const [key, timestamp] of dedupeCache.entries()) {
    if (nowMs - timestamp > COOLDOWN_MS) {
      dedupeCache.delete(key);
    }
  }
  if (dedupeCache.size <= MAX_ENTRIES) {
    return;
  }
  const ordered = [...dedupeCache.entries()].sort((left, right) => left[1] - right[1]);
  const removeCount = dedupeCache.size - MAX_ENTRIES;
  for (let index = 0; index < removeCount; index += 1) {
    dedupeCache.delete(ordered[index][0]);
  }
}

function isValidTuple(userID: number, roomID: number, senderUserID: number, messageID: number): boolean {
  return (
    Number.isFinite(userID)
    && userID > 0
    && Number.isFinite(roomID)
    && roomID > 0
    && Number.isFinite(senderUserID)
    && senderUserID > 0
    && Number.isFinite(messageID)
    && messageID > 0
  );
}

export function shouldCooldownResyncRequest(
  userID: number,
  roomID: number,
  senderUserID: number,
  messageID: number,
): boolean {
  if (!isValidTuple(userID, roomID, senderUserID, messageID)) {
    return false;
  }
  loadFromStorage();
  const nowMs = Date.now();
  prune(nowMs);
  const key = buildKey(userID, roomID, senderUserID, messageID);
  const lastRequestedAt = dedupeCache.get(key);
  if (!lastRequestedAt) {
    return false;
  }
  return nowMs - lastRequestedAt < COOLDOWN_MS;
}

export function rememberResyncRequest(
  userID: number,
  roomID: number,
  senderUserID: number,
  messageID: number,
): void {
  if (!isValidTuple(userID, roomID, senderUserID, messageID)) {
    return;
  }
  loadFromStorage();
  const nowMs = Date.now();
  dedupeCache.set(buildKey(userID, roomID, senderUserID, messageID), nowMs);
  prune(nowMs);
  persistToStorage();
}

export function clearResyncRequest(
  userID: number,
  roomID: number,
  senderUserID: number,
  messageID: number,
): void {
  if (!isValidTuple(userID, roomID, senderUserID, messageID)) {
    return;
  }
  loadFromStorage();
  dedupeCache.delete(buildKey(userID, roomID, senderUserID, messageID));
  persistToStorage();
}

export function __resetResyncRecoveryStoreForTests(): void {
  dedupeCache.clear();
  loaded = false;
  if (!canUseStorage()) {
    return;
  }
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage delete failures.
  }
}
