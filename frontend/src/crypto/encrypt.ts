import type { CipherPayload, WrappedKey } from '../types';
import {
  bootstrapSessionFromPreKeyMessage,
  deriveRatchetMessageKey,
  ensureSelfSession,
  prepareSendWrappedKey,
} from './ratchet';
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

async function unwrapContentKey(messageKey: ArrayBuffer, wrapped: WrappedKey): Promise<ArrayBuffer> {
  const mk = await crypto.subtle.importKey(
    'raw',
    messageKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(wrapped.iv) },
    mk,
    fromBase64(wrapped.wrappedKey),
  );
}

export async function encryptForRecipients(
  plaintext: string,
  senderUserID: number,
  senderDeviceID: string,
  identity: Identity,
  recipients: RecipientAddress[],
): Promise<CipherPayload> {
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
  const rawMessageKey = await crypto.subtle.exportKey('raw', messageKey);

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

    const wrapped = await prepareSendWrappedKey(session, rawMessageKey);
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
    version: 3,
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
    ...unsignedPayload,
    signature,
  };
}

export async function decryptPayload(
  payload: CipherPayload,
  localUserID: number,
  localDeviceID: string,
  senderUserID: number,
  senderDeviceID: string,
  identity: Identity,
): Promise<string> {
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

  const wrapped = payload.wrappedKeys[buildRecipientAddress(localUserID, localDeviceID)];
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
    // Warn but don't throw: recovery payloads or key migrations may carry a stale signing key
    console.warn('[decrypt] local signing key fingerprint mismatch – proceeding with caution');
  }

  const decryptWithSession = async (targetSession: NonNullable<typeof session>): Promise<ArrayBuffer> => {
    const messageKey = await deriveRatchetMessageKey(targetSession, wrapped);
    const rawContentKey = await unwrapContentKey(messageKey, wrapped);
    await writeSession(targetSession);
    return rawContentKey;
  };

  let rawContentKey: ArrayBuffer;
  try {
    const sessionCopy = { ...session, skipped: { ...session.skipped } };
    rawContentKey = await decryptWithSession(sessionCopy);
  } catch (primaryReason) {
    // Recovery payloads and forced rekey payloads may carry pre-key headers that should
    // bootstrap a fresh session if the local state is stale.
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
        rawContentKey = await decryptWithSession(bootstrapSession);
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
  return new TextDecoder().decode(plaintext);
}
