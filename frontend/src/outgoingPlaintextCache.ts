type OutgoingPlaintextRecord = {
  plaintext: string;
  createdAtMs: number;
};

const CACHE_TTL_MS = 30 * 60 * 1000;
const CACHE_MAX_SIZE = 400;
const outgoingPlaintextCache = new Map<string, OutgoingPlaintextRecord>();

function buildCacheKey(userID: number, roomID: number, signature: string): string {
  return `${userID}:${roomID}:${signature}`;
}

function pruneCache(nowMs: number): void {
  for (const [key, record] of outgoingPlaintextCache.entries()) {
    if (nowMs - record.createdAtMs > CACHE_TTL_MS) {
      outgoingPlaintextCache.delete(key);
    }
  }
  if (outgoingPlaintextCache.size <= CACHE_MAX_SIZE) {
    return;
  }
  const ordered = [...outgoingPlaintextCache.entries()]
    .sort((left, right) => left[1].createdAtMs - right[1].createdAtMs);
  const removeCount = outgoingPlaintextCache.size - CACHE_MAX_SIZE;
  for (let index = 0; index < removeCount; index += 1) {
    outgoingPlaintextCache.delete(ordered[index][0]);
  }
}

export function rememberOutgoingPlaintext(
  userID: number,
  roomID: number,
  signature: string,
  plaintext: string,
): void {
  const normalizedSignature = signature.trim();
  if (
    !Number.isFinite(userID) ||
    userID <= 0 ||
    !Number.isFinite(roomID) ||
    roomID <= 0 ||
    !normalizedSignature ||
    !plaintext
  ) {
    return;
  }
  const nowMs = Date.now();
  pruneCache(nowMs);
  outgoingPlaintextCache.set(buildCacheKey(userID, roomID, normalizedSignature), {
    plaintext,
    createdAtMs: nowMs,
  });
}

export function readOutgoingPlaintext(
  userID: number,
  roomID: number,
  signature: string,
): string | null {
  const normalizedSignature = signature.trim();
  if (
    !Number.isFinite(userID) ||
    userID <= 0 ||
    !Number.isFinite(roomID) ||
    roomID <= 0 ||
    !normalizedSignature
  ) {
    return null;
  }
  const nowMs = Date.now();
  pruneCache(nowMs);
  const key = buildCacheKey(userID, roomID, normalizedSignature);
  const record = outgoingPlaintextCache.get(key);
  if (!record) {
    return null;
  }
  if (nowMs - record.createdAtMs > CACHE_TTL_MS) {
    outgoingPlaintextCache.delete(key);
    return null;
  }
  return record.plaintext;
}
