import type { CipherPayload, WrappedKey } from '../types';
import {
  bootstrapSessionFromPreKeyMessage,
  deriveRatchetMessageKey,
  ensureSelfSession,
  prepareSendWrappedKey,
} from './ratchet';
import { consumeOneTimePreKey } from './identity';
import { readSession, writeSession } from './store';
import type { Identity } from './types';
import {
  canonicalAckPayloadForSignature,
  buildRecipientAddress,
  canonicalCipherPayloadForSignature,
  fromBase64,
  requireCryptoSupport,
  signingKeyFingerprint,
  toBase64,
} from './utils';
import {
  normalizeECDSASignatureForTransport,
  verifyECDSASignatureWithFallback,
} from './signature';
import type { RecipientAddress } from './types';

async function signCipherPayload(payload: CipherPayload, privateKey: CryptoKey): Promise<string> {
  const canonical = canonicalCipherPayloadForSignature(payload);
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(canonical),
  );
  const normalized = normalizeECDSASignatureForTransport(signature);
  return toBase64(normalized);
}

export async function signDecryptAck(
  roomID: number,
  messageID: number,
  fromUserID: number,
  signingPrivateKey: CryptoKey,
): Promise<string> {
  const canonical = canonicalAckPayloadForSignature(roomID, messageID, fromUserID);
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    signingPrivateKey,
    new TextEncoder().encode(canonical),
  );
  const normalized = normalizeECDSASignatureForTransport(signature);
  return toBase64(normalized);
}

async function verifyCipherPayloadSignature(payload: CipherPayload): Promise<boolean> {
  if (!payload.signature || !payload.senderSigningPublicKeyJwk) {
    return false;
  }
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    payload.senderSigningPublicKeyJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify'],
  );
  const canonical = canonicalCipherPayloadForSignature(payload);
  return verifyECDSASignatureWithFallback(
    publicKey,
    new TextEncoder().encode(canonical),
    fromBase64(payload.signature),
  );
}

async function unwrapContentKey(
  messageKey: ArrayBuffer,
  wrapped: WrappedKey,
  expectedRecipientAAD: string,
): Promise<ArrayBuffer> {
  const mk = await crypto.subtle.importKey(
    'raw',
    messageKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
  const encrypted = fromBase64(wrapped.wrappedKey);
  const iv = fromBase64(wrapped.iv);
  if (typeof wrapped.recipientAad === 'string' && wrapped.recipientAad.trim()) {
    if (wrapped.recipientAad !== expectedRecipientAAD) {
      throw new Error('wrapped key recipient binding mismatch');
    }
    return crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: new TextEncoder().encode(expectedRecipientAAD),
      },
      mk,
      encrypted,
    );
  }
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, mk, encrypted);
}

export async function encryptForRecipientsWithContentKey(
  plaintext: string,
  senderUserID: number,
  senderDeviceID: string,
  identity: Identity,
  recipients: RecipientAddress[],
): Promise<{ payload: CipherPayload; rawContentKey: ArrayBuffer }> {
  requireCryptoSupport();
  if (!plaintext.trim()) {
    throw new Error('message cannot be empty');
  }

  const messageKey = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
  const messageIV = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: messageIV },
    messageKey,
    new TextEncoder().encode(plaintext),
  );
  const rawContentKey = await crypto.subtle.exportKey('raw', messageKey);

  const wrappedKeys: Record<string, WrappedKey> = {};
  const missingRecipients: string[] = [];
  for (const recipient of recipients) {
    const numericRecipient = Number(recipient.userID);
    const recipientDeviceID = typeof recipient.deviceID === 'string' ? recipient.deviceID.trim() : '';
    if (!Number.isFinite(numericRecipient) || numericRecipient <= 0 || !recipientDeviceID) {
      continue;
    }

    const session = numericRecipient === senderUserID && recipientDeviceID === senderDeviceID
      ? await ensureSelfSession(senderUserID, senderDeviceID, identity)
      : await readSession(senderUserID, senderDeviceID, numericRecipient, recipientDeviceID);
    if (!session || session.status !== 'ready') {
      missingRecipients.push(buildRecipientAddress(numericRecipient, recipientDeviceID));
      continue;
    }

    const wrapped = await prepareSendWrappedKey(session, rawContentKey);
    wrappedKeys[buildRecipientAddress(numericRecipient, recipientDeviceID)] = wrapped;
    await writeSession(session);
  }

  if (missingRecipients.length > 0) {
    const deduped = [...new Set(missingRecipients)].sort((left, right) => left.localeCompare(right));
    throw new Error(`missing ready ratchet sessions for recipients: ${deduped.join(',')}`);
  }

  if (Object.keys(wrappedKeys).length === 0) {
    throw new Error('no recipient session is ready');
  }

  const unsignedPayload: CipherPayload = {
    version: 4,
    ciphertext: toBase64(ciphertext),
    messageIv: toBase64(messageIV),
    wrappedKeys,
    senderPublicKeyJwk: identity.publicKeyJwk,
    senderSigningPublicKeyJwk: identity.signingPublicKeyJwk,
    contentType: 'text/plain',
    senderDeviceId: identity.activeKeyID,
    encryptionScheme: 'DOUBLE_RATCHET_V1',
  };
  const signature = await signCipherPayload(unsignedPayload, identity.signingPrivateKey);
  return {
    payload: {
      ...unsignedPayload,
      signature,
    },
    rawContentKey,
  };
}

export async function encryptForRecipients(
  plaintext: string,
  senderUserID: number,
  senderDeviceID: string,
  identity: Identity,
  recipients: RecipientAddress[],
): Promise<CipherPayload> {
  const result = await encryptForRecipientsWithContentKey(
    plaintext,
    senderUserID,
    senderDeviceID,
    identity,
    recipients,
  );
  return result.payload;
}

export async function decryptPayload(
  payload: CipherPayload,
  localUserID: number,
  localDeviceID: string,
  senderUserID: number,
  senderDeviceID: string,
  identity: Identity,
): Promise<string> {
  const result = await decryptPayloadWithContentKey(
    payload,
    localUserID,
    localDeviceID,
    senderUserID,
    senderDeviceID,
    identity,
  );
  return result.plaintext;
}

export async function decryptPayloadWithContentKey(
  payload: CipherPayload,
  localUserID: number,
  localDeviceID: string,
  senderUserID: number,
  senderDeviceID: string,
  identity: Identity,
): Promise<{ plaintext: string; rawContentKey: ArrayBuffer }> {
  requireCryptoSupport();

  if (!payload.senderSigningPublicKeyJwk || !payload.signature) {
    if (payload.encryptionScheme === 'DOUBLE_RATCHET_V1') {
      throw new Error('message signature is required for double-ratchet payloads');
    }
  } else {
    const verified = await verifyCipherPayloadSignature(payload);
    if (!verified) {
      throw new Error('message signature verification failed');
    }
  }

  const recipientAddress = buildRecipientAddress(localUserID, localDeviceID);
  const wrapped = payload.wrappedKeys[recipientAddress];
  if (!wrapped) {
    throw new Error('no wrapped key for this user');
  }

  if (payload.encryptionScheme !== 'DOUBLE_RATCHET_V1') {
    throw new Error('legacy encryption payload is no longer supported');
  }

  let session = senderUserID === localUserID && senderDeviceID === localDeviceID
    ? await ensureSelfSession(localUserID, localDeviceID, identity)
    : await readSession(localUserID, localDeviceID, senderUserID, senderDeviceID);

  if (!session && wrapped.preKeyMessage) {
    session = await bootstrapSessionFromPreKeyMessage(
      localUserID,
      localDeviceID,
      senderUserID,
      senderDeviceID,
      identity,
      wrapped,
    );
  }

  if (!session || session.status !== 'ready') {
    throw new Error(`double-ratchet session missing with sender ${senderUserID}:${senderDeviceID}`);
  }

  const isLocalSelfSender = senderUserID === localUserID && senderDeviceID === localDeviceID;
  if (!isLocalSelfSender) {
    if (!payload.senderSigningPublicKeyJwk && !session.peerIdentitySigningPublicKeyJwk) {
      throw new Error('double-ratchet session is missing peer signing identity');
    }
    if (payload.senderSigningPublicKeyJwk) {
      const incomingFingerprint = signingKeyFingerprint(payload.senderSigningPublicKeyJwk);
      const sessionFingerprint = signingKeyFingerprint(session.peerIdentitySigningPublicKeyJwk);
      if (!session.peerIdentitySigningPublicKeyJwk || incomingFingerprint !== sessionFingerprint) {
        session.peerIdentitySigningPublicKeyJwk = payload.senderSigningPublicKeyJwk;
        session.updatedAt = new Date().toISOString();
      }
    }
  }
  if (isLocalSelfSender && payload.senderSigningPublicKeyJwk && signingKeyFingerprint(payload.senderSigningPublicKeyJwk) !== signingKeyFingerprint(identity.signingPublicKeyJwk)) {
    console.warn('[decrypt] local signing key fingerprint mismatch – proceeding with caution');
  }

  const unwrapWithSession = async (targetSession: NonNullable<typeof session>): Promise<ArrayBuffer> => {
    const messageKey = await deriveRatchetMessageKey(targetSession, wrapped);
    return unwrapContentKey(messageKey, wrapped, recipientAddress);
  };

  let rawContentKey: ArrayBuffer;
  let sessionToCommit: NonNullable<typeof session> | null = null;
  try {
    const sessionCopy = { ...session, skipped: { ...session.skipped } };
    rawContentKey = await unwrapWithSession(sessionCopy);
    sessionToCommit = sessionCopy;
  } catch (primaryReason) {
    if (!isLocalSelfSender && wrapped.preKeyMessage) {
      try {
        const bootstrapSession = await bootstrapSessionFromPreKeyMessage(
          localUserID,
          localDeviceID,
          senderUserID,
          senderDeviceID,
          identity,
          wrapped,
        );
        rawContentKey = await unwrapWithSession(bootstrapSession);
        sessionToCommit = bootstrapSession;
      } catch {
        throw primaryReason;
      }
    } else {
      throw primaryReason;
    }
  }

  const contentKey = await crypto.subtle.importKey(
    'raw',
    rawContentKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(payload.messageIv) },
    contentKey,
    fromBase64(payload.ciphertext),
  );
  if (sessionToCommit) {
    await writeSession(sessionToCommit);
    if (!isLocalSelfSender && wrapped.preKeyMessage?.oneTimePreKeyId != null) {
      await consumeOneTimePreKey(identity, Math.floor(wrapped.preKeyMessage.oneTimePreKeyId));
    }
  }
  return {
    plaintext: new TextDecoder().decode(plaintext),
    rawContentKey,
  };
}

export async function wrapContentKeyForRecipient(
  senderUserID: number,
  senderDeviceID: string,
  identity: Identity,
  recipient: RecipientAddress,
  rawContentKey: ArrayBuffer,
): Promise<WrappedKey> {
  requireCryptoSupport();
  const numericRecipient = Number(recipient.userID);
  const recipientDeviceID = typeof recipient.deviceID === 'string' ? recipient.deviceID.trim() : '';
  if (!Number.isFinite(numericRecipient) || numericRecipient <= 0 || !recipientDeviceID) {
    throw new Error('invalid envelope recipient');
  }

  const session = numericRecipient === senderUserID && recipientDeviceID === senderDeviceID
    ? await ensureSelfSession(senderUserID, senderDeviceID, identity)
    : await readSession(senderUserID, senderDeviceID, numericRecipient, recipientDeviceID);
  if (!session || session.status !== 'ready') {
    throw new Error(`missing ready ratchet session for recipient ${buildRecipientAddress(numericRecipient, recipientDeviceID)}`);
  }

  const wrapped = await prepareSendWrappedKey(session, rawContentKey);
  await writeSession(session);
  return wrapped;
}
