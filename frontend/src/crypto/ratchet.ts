import type { RatchetHandshakeFrame, WrappedKey } from '../types';
import {
  DR_MAX_SKIP,
  DR_RK_INFO,
  DR_ROOT_INFO,
  DR_SESSION_VERSION,
  SIGNAL_INITIATOR_CHAIN_INFO,
  SIGNAL_RESPONDER_CHAIN_INFO,
  SIGNAL_X3DH_INFO,
} from './constants';
import {
  consumeOneTimePreKey,
  findOneTimePreKey,
  findSignedPreKey,
} from './identity';
import { deleteSession, readSession, writeSession } from './store';
import type {
  Identity,
  RecipientAddress,
  RatchetHandshakeOutgoing,
  RatchetSessionRecord,
  RatchetSessionStatus,
  SignalBundleResolver,
  SignalPreKeyBundle,
} from './types';
import {
  buildSessionID,
  canonicalSignedPreKeyPayload,
  concatBuffers,
  fromBase64,
  ratchetKeyFingerprint,
  requireCryptoSupport,
  signingKeyFingerprint,
  toBase64,
  trimSkippedCache,
} from './utils';
import { verifyECDSASignatureWithFallback } from './signature';

async function generateRatchetKeyPair(): Promise<{ privateKey: CryptoKey; publicKey: CryptoKey; publicKeyJwk: JsonWebKey }> {
  const generated = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  ) as CryptoKeyPair;
  const privateKeyJwk = await crypto.subtle.exportKey('jwk', generated.privateKey);
  const publicKeyJwk = await crypto.subtle.exportKey('jwk', generated.publicKey);
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    privateKeyJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    publicKeyJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    [],
  );
  return {
    privateKey,
    publicKey,
    publicKeyJwk,
  };
}

async function deriveDH(privateKey: CryptoKey, remotePublicJwk: JsonWebKey): Promise<ArrayBuffer> {
  const remotePublic = await crypto.subtle.importKey(
    'jwk',
    remotePublicJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  return crypto.subtle.deriveBits(
    { name: 'ECDH', public: remotePublic } as EcdhKeyDeriveParams,
    privateKey,
    256,
  );
}

async function hmacSha256(key: ArrayBuffer, data: ArrayBuffer | Uint8Array | string): Promise<ArrayBuffer> {
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const payload = typeof data === 'string'
    ? new TextEncoder().encode(data)
    : data instanceof Uint8Array
      ? data
      : new Uint8Array(data);
  const payloadCopy = new Uint8Array(payload.byteLength);
  payloadCopy.set(payload);
  return crypto.subtle.sign('HMAC', hmacKey, payloadCopy);
}

async function hkdf(
  ikm: ArrayBuffer,
  salt: ArrayBuffer,
  info: string,
  lengthBytes: number,
): Promise<ArrayBuffer> {
  const base = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt,
      info: new TextEncoder().encode(info),
    },
    base,
    lengthBytes * 8,
  );
}

async function verifySignedPreKey(bundle: SignalPreKeyBundle): Promise<boolean> {
  const signatureRaw = fromBase64(bundle.signedPreKey.signature);
  const signingPublicKey = await crypto.subtle.importKey(
    'jwk',
    bundle.identitySigningPublicKeyJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['verify'],
  );
  const canonical = canonicalSignedPreKeyPayload(bundle.signedPreKey.publicKeyJwk);
  return verifyECDSASignatureWithFallback(
    signingPublicKey,
    new TextEncoder().encode(canonical),
    signatureRaw,
  );
}

async function deriveX3DHMasterForInitiator(
  identity: Identity,
  ephemeralPrivateKey: CryptoKey,
  bundle: SignalPreKeyBundle,
): Promise<ArrayBuffer> {
  const dh1 = await deriveDH(identity.privateKey, bundle.signedPreKey.publicKeyJwk);
  const dh2 = await deriveDH(ephemeralPrivateKey, bundle.identityKeyJwk);
  const dh3 = await deriveDH(ephemeralPrivateKey, bundle.signedPreKey.publicKeyJwk);
  const parts = [dh1, dh2, dh3];
  if (bundle.oneTimePreKey?.publicKeyJwk) {
    const dh4 = await deriveDH(ephemeralPrivateKey, bundle.oneTimePreKey.publicKeyJwk);
    parts.push(dh4);
  }
  return hkdf(
    concatBuffers(...parts),
    new Uint8Array(32).buffer,
    SIGNAL_X3DH_INFO,
    32,
  );
}

async function deriveX3DHMasterForResponder(
  identity: Identity,
  senderIdentityKeyJwk: JsonWebKey,
  senderEphemeralKeyJwk: JsonWebKey,
  signedPreKeyID: number,
  oneTimePreKeyID: number | null,
): Promise<ArrayBuffer> {
  const signedPreKey = findSignedPreKey(identity, signedPreKeyID);
  if (!signedPreKey) {
    throw new Error('missing local signed prekey for incoming prekey message');
  }
  const dh1 = await deriveDH(signedPreKey.privateKey, senderIdentityKeyJwk);
  const dh2 = await deriveDH(identity.privateKey, senderEphemeralKeyJwk);
  const dh3 = await deriveDH(signedPreKey.privateKey, senderEphemeralKeyJwk);
  const parts = [dh1, dh2, dh3];
  if (oneTimePreKeyID !== null) {
    const oneTimePreKey = findOneTimePreKey(identity, oneTimePreKeyID);
    if (!oneTimePreKey) {
      throw new Error('missing local one-time prekey for incoming prekey message');
    }
    const dh4 = await deriveDH(oneTimePreKey.privateKey, senderEphemeralKeyJwk);
    parts.push(dh4);
  }
  return hkdf(
    concatBuffers(...parts),
    new Uint8Array(32).buffer,
    SIGNAL_X3DH_INFO,
    32,
  );
}

async function deriveInitialChains(masterKey: ArrayBuffer): Promise<{
  rootKey: string;
  initiatorChain: string;
  responderChain: string;
}> {
  const rootRaw = await hkdf(masterKey, new Uint8Array(32).buffer, DR_ROOT_INFO, 32);
  const initRaw = await hmacSha256(rootRaw, SIGNAL_INITIATOR_CHAIN_INFO);
  const respRaw = await hmacSha256(rootRaw, SIGNAL_RESPONDER_CHAIN_INFO);
  return {
    rootKey: toBase64(rootRaw),
    initiatorChain: toBase64(initRaw),
    responderChain: toBase64(respRaw),
  };
}

async function kdfRK(rootKeyB64: string, dhSecret: ArrayBuffer): Promise<{ rootKey: string; chainKey: string }> {
  const rootRaw = fromBase64(rootKeyB64);
  const derived = await hkdf(dhSecret, rootRaw, DR_RK_INFO, 64);
  const bytes = new Uint8Array(derived);
  return {
    rootKey: toBase64(bytes.slice(0, 32)),
    chainKey: toBase64(bytes.slice(32, 64)),
  };
}

async function kdfCK(chainKeyB64: string): Promise<{ nextChainKey: string; messageKey: ArrayBuffer }> {
  const chainRaw = fromBase64(chainKeyB64);
  const nextRaw = await hmacSha256(chainRaw, new Uint8Array([1]));
  const messageRaw = await hmacSha256(chainRaw, new Uint8Array([2]));
  return {
    nextChainKey: toBase64(nextRaw),
    messageKey: messageRaw,
  };
}

function makeSkippedMessageID(remoteDH: JsonWebKey | null, n: number): string {
  const fp = ratchetKeyFingerprint(remoteDH);
  return `${fp}:${n}`;
}

export async function ensureSelfSession(
  userID: number,
  localDeviceID: string,
  identity: Identity,
): Promise<RatchetSessionRecord> {
  const existing = await readSession(userID, localDeviceID, userID, localDeviceID);
  if (existing && existing.status === 'ready') {
    if (
      signingKeyFingerprint(existing.peerIdentitySigningPublicKeyJwk)
      !== signingKeyFingerprint(identity.signingPublicKeyJwk)
    ) {
      existing.peerIdentitySigningPublicKeyJwk = identity.signingPublicKeyJwk;
      existing.updatedAt = new Date().toISOString();
      await writeSession(existing);
    }
    return existing;
  }

  const selfDH = await generateRatchetKeyPair();
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const seedRaw = seed.buffer.slice(seed.byteOffset, seed.byteOffset + seed.byteLength);
  const rootRaw = await hkdf(seedRaw, new Uint8Array(32).buffer, DR_ROOT_INFO, 32);
  const chainRaw = await hmacSha256(rootRaw, `${SIGNAL_INITIATOR_CHAIN_INFO}:${crypto.randomUUID()}`);

  const session: RatchetSessionRecord = {
    id: buildSessionID(userID, localDeviceID, userID, localDeviceID),
    userID,
    localDeviceID,
    peerUserID: userID,
    peerDeviceID: localDeviceID,
    status: 'ready',
    rootKey: toBase64(rootRaw),
    sendChainKey: toBase64(chainRaw),
    recvChainKey: toBase64(chainRaw),
    sendCount: 0,
    recvCount: 0,
    previousSendCount: 0,
    skipped: {},
    dhSendPrivate: selfDH.privateKey,
    dhSendPublicJwk: selfDH.publicKeyJwk,
    dhRecvPublicJwk: selfDH.publicKeyJwk,
    peerIdentityPublicKeyJwk: identity.publicKeyJwk,
    peerIdentitySigningPublicKeyJwk: identity.signingPublicKeyJwk,
    pendingPreKey: null,
    isSelfSession: true,
    updatedAt: new Date().toISOString(),
  };
  await writeSession(session);
  return session;
}

function consumeSkippedMessageKey(
  session: RatchetSessionRecord,
  remoteDH: JsonWebKey | null,
  n: number,
): ArrayBuffer | null {
  const id = makeSkippedMessageID(remoteDH, n);
  const value = session.skipped[id];
  if (!value) {
    return null;
  }
  delete session.skipped[id];
  return fromBase64(value);
}

async function nextReceiveMessageKey(session: RatchetSessionRecord): Promise<ArrayBuffer> {
  const { nextChainKey, messageKey } = await kdfCK(session.recvChainKey);
  session.recvChainKey = nextChainKey;
  session.recvCount += 1;
  return messageKey;
}

async function skipMessageKeys(session: RatchetSessionRecord, until: number): Promise<void> {
  const target = Math.max(0, Math.floor(until));
  if (target <= session.recvCount) {
    return;
  }
  if (target - session.recvCount > DR_MAX_SKIP) {
    throw new Error('too many skipped messages in double-ratchet chain');
  }
  while (session.recvCount < target) {
    const messageKey = await nextReceiveMessageKey(session);
    const keyID = makeSkippedMessageID(session.dhRecvPublicJwk, session.recvCount - 1);
    session.skipped[keyID] = toBase64(messageKey);
    session.skipped = trimSkippedCache(session.skipped);
  }
}

async function applyDHRatchet(session: RatchetSessionRecord, nextRemoteDH: JsonWebKey): Promise<void> {
  session.previousSendCount = session.sendCount;
  session.sendCount = 0;
  session.recvCount = 0;
  session.dhRecvPublicJwk = nextRemoteDH;

  const firstDH = await deriveDH(session.dhSendPrivate, nextRemoteDH);
  const step1 = await kdfRK(session.rootKey, firstDH);

  const nextDH = await generateRatchetKeyPair();
  const secondDH = await deriveDH(nextDH.privateKey, nextRemoteDH);
  const step2 = await kdfRK(step1.rootKey, secondDH);

  session.rootKey = step2.rootKey;
  session.recvChainKey = step1.chainKey;
  session.sendChainKey = step2.chainKey;
  session.dhSendPrivate = nextDH.privateKey;
  session.dhSendPublicJwk = nextDH.publicKeyJwk;
}

async function wrapContentKey(messageKey: ArrayBuffer, rawContentKey: ArrayBuffer): Promise<{ iv: string; wrappedKey: string }> {
  const wrapIV = crypto.getRandomValues(new Uint8Array(12));
  const mk = await crypto.subtle.importKey(
    'raw',
    messageKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt'],
  );
  const wrapped = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: wrapIV },
    mk,
    rawContentKey,
  );
  return {
    iv: toBase64(wrapIV),
    wrappedKey: toBase64(wrapped),
  };
}

function buildWrappedKeyHeader(
  session: RatchetSessionRecord,
  wrapped: { iv: string; wrappedKey: string },
): WrappedKey {
  const preKeyMessage = session.pendingPreKey;
  return {
    iv: wrapped.iv,
    wrappedKey: wrapped.wrappedKey,
    ratchetDhPublicKeyJwk: session.dhSendPublicJwk,
    messageNumber: session.sendCount,
    previousChainLength: session.previousSendCount,
    sessionVersion: DR_SESSION_VERSION,
    preKeyMessage: preKeyMessage
      ? {
        identityKeyJwk: preKeyMessage.identityKeyJwk,
        identitySigningPublicKeyJwk: preKeyMessage.identitySigningPublicKeyJwk,
        ephemeralKeyJwk: preKeyMessage.ephemeralKeyJwk,
        signedPreKeyId: preKeyMessage.signedPreKeyId,
        oneTimePreKeyId: preKeyMessage.oneTimePreKeyId ?? undefined,
        preKeyBundleUpdatedAt: preKeyMessage.preKeyBundleUpdatedAt,
      }
      : undefined,
  };
}

export async function prepareSendWrappedKey(
  session: RatchetSessionRecord,
  rawContentKey: ArrayBuffer,
): Promise<WrappedKey> {
  const { nextChainKey, messageKey } = await kdfCK(session.sendChainKey);
  const wrapped = await wrapContentKey(messageKey, rawContentKey);
  const payload = buildWrappedKeyHeader(session, wrapped);
  session.sendChainKey = nextChainKey;
  session.sendCount += 1;
  if (session.pendingPreKey && session.sendCount >= 3) {
    session.pendingPreKey = null;
  }
  session.updatedAt = new Date().toISOString();
  return payload;
}

export async function deriveRatchetMessageKey(
  session: RatchetSessionRecord,
  wrapper: WrappedKey,
): Promise<ArrayBuffer> {
  const messageNumber = Number.isFinite(Number(wrapper.messageNumber))
    ? Math.max(0, Number(wrapper.messageNumber))
    : 0;
  const previousChainLength = Number.isFinite(Number(wrapper.previousChainLength))
    ? Math.max(0, Number(wrapper.previousChainLength))
    : 0;

  if (session.isSelfSession) {
    await skipMessageKeys(session, messageNumber);
    const key = await nextReceiveMessageKey(session);
    session.updatedAt = new Date().toISOString();
    return key;
  }

  const headerDH = wrapper.ratchetDhPublicKeyJwk ?? null;
  if (!headerDH) {
    throw new Error('double-ratchet header missing remote DH public key');
  }

  const skipped = consumeSkippedMessageKey(session, headerDH, messageNumber);
  if (skipped) {
    session.updatedAt = new Date().toISOString();
    return skipped;
  }

  if (!session.dhRecvPublicJwk || ratchetKeyFingerprint(session.dhRecvPublicJwk) !== ratchetKeyFingerprint(headerDH)) {
    await skipMessageKeys(session, previousChainLength);
    await applyDHRatchet(session, headerDH);
  }

  await skipMessageKeys(session, messageNumber);
  const key = await nextReceiveMessageKey(session);
  session.updatedAt = new Date().toISOString();
  return key;
}

async function createInitiatorSession(
  localUserID: number,
  localDeviceID: string,
  peerUserID: number,
  peerDeviceID: string,
  identity: Identity,
  bundle: SignalPreKeyBundle,
): Promise<RatchetSessionRecord> {
  const signatureVerified = await verifySignedPreKey(bundle);
  if (!signatureVerified) {
    throw new Error('signal prekey bundle signature verification failed');
  }

  const initiatorRatchet = await generateRatchetKeyPair();
  const master = await deriveX3DHMasterForInitiator(identity, initiatorRatchet.privateKey, bundle);
  const chains = await deriveInitialChains(master);

  return {
    id: buildSessionID(localUserID, localDeviceID, peerUserID, peerDeviceID),
    userID: localUserID,
    localDeviceID,
    peerUserID,
    peerDeviceID,
    status: 'ready',
    rootKey: chains.rootKey,
    sendChainKey: chains.initiatorChain,
    recvChainKey: chains.responderChain,
    sendCount: 0,
    recvCount: 0,
    previousSendCount: 0,
    skipped: {},
    dhSendPrivate: initiatorRatchet.privateKey,
    dhSendPublicJwk: initiatorRatchet.publicKeyJwk,
    dhRecvPublicJwk: bundle.signedPreKey.publicKeyJwk,
    peerIdentityPublicKeyJwk: bundle.identityKeyJwk,
    peerIdentitySigningPublicKeyJwk: bundle.identitySigningPublicKeyJwk,
    pendingPreKey: {
      identityKeyJwk: identity.publicKeyJwk,
      identitySigningPublicKeyJwk: identity.signingPublicKeyJwk,
      ephemeralKeyJwk: initiatorRatchet.publicKeyJwk,
      signedPreKeyId: bundle.signedPreKey.keyId,
      oneTimePreKeyId: bundle.oneTimePreKey?.keyId ?? null,
      preKeyBundleUpdatedAt: bundle.updatedAt ?? new Date().toISOString(),
    },
    isSelfSession: false,
    updatedAt: new Date().toISOString(),
  };
}

export async function bootstrapSessionFromPreKeyMessage(
  localUserID: number,
  localDeviceID: string,
  senderUserID: number,
  senderDeviceID: string,
  identity: Identity,
  wrapped: WrappedKey,
): Promise<RatchetSessionRecord> {
  const header = wrapped.preKeyMessage;
  if (!header || !header.identityKeyJwk || !header.ephemeralKeyJwk || !header.signedPreKeyId) {
    throw new Error('missing signal prekey message header');
  }
  const master = await deriveX3DHMasterForResponder(
    identity,
    header.identityKeyJwk,
    header.ephemeralKeyJwk,
    Math.floor(header.signedPreKeyId),
    header.oneTimePreKeyId == null ? null : Math.floor(header.oneTimePreKeyId),
  );

  if (header.oneTimePreKeyId != null) {
    await consumeOneTimePreKey(identity, Math.floor(header.oneTimePreKeyId));
  }

  const localSignedPreKey = findSignedPreKey(identity, Math.floor(header.signedPreKeyId));
  if (!localSignedPreKey) {
    throw new Error('missing local signed prekey for incoming prekey message');
  }

  const chains = await deriveInitialChains(master);
  const session: RatchetSessionRecord = {
    id: buildSessionID(localUserID, localDeviceID, senderUserID, senderDeviceID),
    userID: localUserID,
    localDeviceID,
    peerUserID: senderUserID,
    peerDeviceID: senderDeviceID,
    status: 'ready',
    rootKey: chains.rootKey,
    sendChainKey: chains.responderChain,
    recvChainKey: chains.initiatorChain,
    sendCount: 0,
    recvCount: 0,
    previousSendCount: 0,
    skipped: {},
    dhSendPrivate: localSignedPreKey.privateKey,
    dhSendPublicJwk: localSignedPreKey.publicKeyJwk,
    dhRecvPublicJwk: header.ephemeralKeyJwk,
    peerIdentityPublicKeyJwk: header.identityKeyJwk,
    peerIdentitySigningPublicKeyJwk: header.identitySigningPublicKeyJwk ?? identity.signingPublicKeyJwk,
    pendingPreKey: null,
    isSelfSession: false,
    updatedAt: new Date().toISOString(),
  };
  await writeSession(session);
  return session;
}

export async function ensureRatchetSessionsForRecipients(
  localUserID: number,
  localDeviceID: string,
  identity: Identity,
  recipientUserIDs: number[],
  resolveSignalBundle: SignalBundleResolver,
): Promise<RatchetSessionStatus> {
  requireCryptoSupport();

  const readyRecipients: RecipientAddress[] = [];
  const pendingUserIDs: number[] = [];
  const dedupedRecipientIDs = [...new Set(recipientUserIDs
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0))];

  for (const peerUserID of dedupedRecipientIDs) {
    if (peerUserID === localUserID) {
      await ensureSelfSession(localUserID, localDeviceID, identity);
      readyRecipients.push({ userID: localUserID, deviceID: localDeviceID });
      try {
        const localBundleList = await resolveSignalBundle(localUserID);
        const localDeviceBundles = localBundleList.devices.filter((bundle) => {
          if (typeof bundle.deviceId !== 'string') {
            return false;
          }
          const deviceID = bundle.deviceId.trim();
          return Boolean(deviceID) && deviceID !== localDeviceID;
        });
        let localPeerReady = 0;
        for (const bundle of localDeviceBundles) {
          const peerDeviceID = bundle.deviceId.trim();
          try {
            const existing = await readSession(localUserID, localDeviceID, localUserID, peerDeviceID);
            if (existing?.status === 'ready') {
              readyRecipients.push({ userID: localUserID, deviceID: peerDeviceID });
              localPeerReady += 1;
              continue;
            }
            const session = await createInitiatorSession(
              localUserID,
              localDeviceID,
              localUserID,
              peerDeviceID,
              identity,
              bundle,
            );
            await writeSession(session);
            readyRecipients.push({ userID: localUserID, deviceID: peerDeviceID });
            localPeerReady += 1;
          } catch (err) {
            console.warn(`[ratchet] failed to establish self-device session ${peerDeviceID}:`, err);
          }
        }
        if (localDeviceBundles.length > 0 && localPeerReady === 0) {
          pendingUserIDs.push(localUserID);
        }
      } catch (err) {
        console.warn('[ratchet] failed to load local prekey bundles:', err);
      }
      continue;
    }

    try {
      const bundleList = await resolveSignalBundle(peerUserID);
      const deviceBundles = bundleList.devices.filter((bundle) => typeof bundle.deviceId === 'string' && bundle.deviceId.trim());
      if (deviceBundles.length === 0) {
        pendingUserIDs.push(peerUserID);
        continue;
      }

      const userReady: RecipientAddress[] = [];
      for (const bundle of deviceBundles) {
        const peerDeviceID = bundle.deviceId.trim();
        const existing = await readSession(localUserID, localDeviceID, peerUserID, peerDeviceID);
        if (existing?.status === 'ready') {
          userReady.push({ userID: peerUserID, deviceID: peerDeviceID });
          continue;
        }
        const session = await createInitiatorSession(
          localUserID,
          localDeviceID,
          peerUserID,
          peerDeviceID,
          identity,
          bundle,
        );
        await writeSession(session);
        userReady.push({ userID: peerUserID, deviceID: peerDeviceID });
      }

      if (userReady.length === 0) {
        pendingUserIDs.push(peerUserID);
        continue;
      }
      readyRecipients.push(...userReady);
    } catch (err) {
      // Individual peer session failure should not block other recipients
      console.warn(`[ratchet] failed to establish session with user ${peerUserID}:`, err);
      pendingUserIDs.push(peerUserID);
    }
  }

  return { readyRecipients, pendingUserIDs };
}

export async function resetRatchetSession(
  localUserID: number,
  localDeviceID: string,
  peerUserID: number,
  peerDeviceID: string,
): Promise<void> {
  await deleteSession(localUserID, localDeviceID, peerUserID, peerDeviceID);
}

export async function handleRatchetHandshakeFrame(
  _localUserID: number,
  _identity: Identity,
  _frame: RatchetHandshakeFrame,
  _emitHandshake: (outgoing: RatchetHandshakeOutgoing) => void,
): Promise<boolean> {
  void _localUserID;
  void _identity;
  void _frame;
  void _emitHandshake;
  // Signal core mode relies on X3DH prekey bundles; websocket handshakes are ignored.
  return false;
}
