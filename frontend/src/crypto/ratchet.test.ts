import { beforeEach, describe, expect, it } from 'vitest';
import {
  decryptPayload,
  decryptPayloadWithContentKey,
  encryptForRecipients,
  ensureRatchetSessionsForRecipients,
  ensureSelfSession,
  loadOrCreateIdentityForDevice,
  resetRatchetSession,
  wrapContentKeyForRecipient,
  rotateIdentityIfNeeded,
  toSignalPreKeyBundleUpload,
  type SignalPreKeyBundle,
  type SignalPreKeyBundleList,
} from './index';
import { normalizeECDSASignatureForTransport } from './signature';
import { readSession } from './store';
import { canonicalCipherPayloadForSignature, toBase64 } from './utils';

async function clearSecureDB(): Promise<void> {
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase('e2ee-chat-secure-store');
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

function toBundle(
  userID: number,
  username: string,
  identity: Awaited<ReturnType<typeof loadOrCreateIdentityForDevice>>,
  deviceID = identity.activeKeyID,
): SignalPreKeyBundle {
  const upload = toSignalPreKeyBundleUpload(identity);
  return {
    deviceId: deviceID,
    userId: userID,
    username,
    identityKeyJwk: upload.identityKeyJwk,
    identitySigningPublicKeyJwk: upload.identitySigningPublicKeyJwk,
    signedPreKey: {
      ...upload.signedPreKey,
    },
    oneTimePreKey: upload.oneTimePreKeys[0],
    updatedAt: new Date().toISOString(),
  };
}

async function signPayloadForTest(
  payload: Awaited<ReturnType<typeof encryptForRecipients>>,
  signingPrivateKey: CryptoKey,
): Promise<typeof payload> {
  const signatureRaw = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    signingPrivateKey,
    new TextEncoder().encode(canonicalCipherPayloadForSignature(payload)),
  );
  return {
    ...payload,
    signature: toBase64(normalizeECDSASignatureForTransport(signatureRaw)),
  };
}

function toBundleList(
  userID: number,
  username: string,
  identities: Array<Awaited<ReturnType<typeof loadOrCreateIdentityForDevice>>>,
): SignalPreKeyBundleList {
  return {
    userId: userID,
    username,
    devices: identities.map((identity) => toBundle(userID, username, identity)),
    activeDeviceCount: identities.length,
    readyDeviceCount: identities.length,
    missingDeviceCount: 0,
    updatedAt: new Date().toISOString(),
  };
}

describe('signal core ratchet flows', () => {
  beforeEach(async () => {
    await clearSecureDB();
  });

  it('rotates signed prekey material when max age is exceeded', async () => {
    const first = await loadOrCreateIdentityForDevice(101, 'device-101-main');
    await new Promise((resolve) => setTimeout(resolve, 5));

    const result = await rotateIdentityIfNeeded(101, 'device-101-main', 1, 6);

    expect(result.rotated).toBe(true);
    expect(result.identity.signedPreKey.keyID).not.toBe(first.signedPreKey.keyID);
  });

  it('keeps multiple rotated signed prekeys around so older inflight prekey messages stay decryptable', async () => {
    const first = await loadOrCreateIdentityForDevice(102, 'device-102-main');
    expect(first.signedPreKeys.length).toBeGreaterThanOrEqual(1);

    // Force four consecutive rotations with a 1ms max age to simulate a long
    // running client. Each call should add a fresh signed prekey while
    // retaining recent history rather than discarding it after just two
    // rotations as before.
    for (let index = 0; index < 4; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await rotateIdentityIfNeeded(102, 'device-102-main', 1, 12);
    }

    const final = await loadOrCreateIdentityForDevice(102, 'device-102-main');
    expect(final.signedPreKeys.length).toBeGreaterThanOrEqual(4);
    expect(final.signedPreKey.keyID).not.toBe(first.signedPreKey.keyID);
  });

  it('establishes device-level sessions and decrypts across same-account devices', async () => {
    const aliceMobile = await loadOrCreateIdentityForDevice(201, 'alice-mobile');
    const aliceDesktop = await loadOrCreateIdentityForDevice(201, 'alice-desktop');
    const bobPhone = await loadOrCreateIdentityForDevice(202, 'bob-phone');

    const sessionStatus = await ensureRatchetSessionsForRecipients(
      201,
      'alice-mobile',
      aliceMobile,
      [201, 202],
      async (userID) => {
        if (userID === 201) {
          return toBundleList(201, 'alice', [aliceMobile, aliceDesktop]);
        }
        if (userID === 202) {
          return toBundleList(202, 'bob', [bobPhone]);
        }
        throw new Error(`unexpected recipient ${userID}`);
      },
    );
    expect(sessionStatus.pendingUserIDs).toHaveLength(0);

    const payload = await encryptForRecipients(
      'hello bob',
      201,
      'alice-mobile',
      aliceMobile,
      sessionStatus.readyRecipients,
    );

    const bobText = await decryptPayload(payload, 202, 'bob-phone', 201, 'alice-mobile', bobPhone);
    const aliceMobileText = await decryptPayload(payload, 201, 'alice-mobile', 201, 'alice-mobile', aliceMobile);
    const aliceDesktopText = await decryptPayload(payload, 201, 'alice-desktop', 201, 'alice-mobile', aliceDesktop);

    expect(bobText).toBe('hello bob');
    expect(aliceMobileText).toBe('hello bob');
    expect(aliceDesktopText).toBe('hello bob');
    expect(payload.wrappedKeys['201:alice-desktop']?.preKeyMessage).toBeTruthy();
    expect(payload.wrappedKeys['202:bob-phone']?.preKeyMessage).toBeTruthy();
  });

  it('keeps a user pending while an active device has not published keys yet', async () => {
    const alice = await loadOrCreateIdentityForDevice(211, 'alice-main');
    const bobPhone = await loadOrCreateIdentityForDevice(212, 'bob-phone');

    const sessionStatus = await ensureRatchetSessionsForRecipients(
      211,
      'alice-main',
      alice,
      [211, 212],
      async (userID) => {
        if (userID === 211) {
          return toBundleList(211, 'alice', [alice]);
        }
        if (userID === 212) {
          return {
            ...toBundleList(212, 'bob', [bobPhone]),
            activeDeviceCount: 2,
            readyDeviceCount: 1,
            missingDeviceCount: 1,
          };
        }
        throw new Error(`unexpected recipient ${userID}`);
      },
    );

    expect(sessionStatus.pendingUserIDs).toEqual([212]);
    expect(sessionStatus.readyRecipients).toEqual([{ userID: 211, deviceID: 'alice-main' }]);
  });

  it('rekeys an existing device session when the peer identity bundle changes', async () => {
    const alice = await loadOrCreateIdentityForDevice(251, 'alice-main');
    const bobOld = await loadOrCreateIdentityForDevice(252, 'bob-main');
    const bobNewMaterial = await loadOrCreateIdentityForDevice(253, 'bob-replacement-material');

    const oldBundle = toBundle(252, 'bob', bobOld, 'bob-main');
    const newBundle = toBundle(252, 'bob', bobNewMaterial, 'bob-main');

    await ensureRatchetSessionsForRecipients(
      251,
      'alice-main',
      alice,
      [252],
      async () => ({
        userId: 252,
        username: 'bob',
        devices: [oldBundle],
        activeDeviceCount: 1,
        readyDeviceCount: 1,
        missingDeviceCount: 0,
        updatedAt: new Date().toISOString(),
      }),
    );
    const oldSession = await readSession(251, 'alice-main', 252, 'bob-main');
    expect(oldSession?.peerIdentityPublicKeyJwk).toEqual(oldBundle.identityKeyJwk);

    await ensureRatchetSessionsForRecipients(
      251,
      'alice-main',
      alice,
      [252],
      async () => ({
        userId: 252,
        username: 'bob',
        devices: [newBundle],
        activeDeviceCount: 1,
        readyDeviceCount: 1,
        missingDeviceCount: 0,
        updatedAt: new Date().toISOString(),
      }),
    );

    const replacementSession = await readSession(251, 'alice-main', 252, 'bob-main');
    expect(replacementSession?.peerIdentityPublicKeyJwk).toEqual(newBundle.identityKeyJwk);
    expect(replacementSession?.peerIdentitySigningPublicKeyJwk).toEqual(newBundle.identitySigningPublicKeyJwk);
  });

  it('rejects ciphertext tampering via signature verification', async () => {
    const alice = await loadOrCreateIdentityForDevice(301, 'alice-main');
    const bob = await loadOrCreateIdentityForDevice(302, 'bob-main');

    const sessionStatus = await ensureRatchetSessionsForRecipients(
      301,
      'alice-main',
      alice,
      [301, 302],
      async (userID) => {
        if (userID === 301) {
          return toBundleList(301, 'alice', [alice]);
        }
        if (userID === 302) {
          return toBundleList(302, 'bob', [bob]);
        }
        throw new Error(`unexpected recipient ${userID}`);
      },
    );

    const payload = await encryptForRecipients(
      'integrity-check',
      301,
      'alice-main',
      alice,
      sessionStatus.readyRecipients,
    );
    const tampered = {
      ...payload,
      ciphertext: `${payload.ciphertext}A`,
    };

    await expect(decryptPayload(tampered, 302, 'bob-main', 301, 'alice-main', bob)).rejects.toThrow(
      'message signature verification failed',
    );
  });

  it('allows V4 payloads to be verified with only this device envelope', async () => {
    const alice = await loadOrCreateIdentityForDevice(331, 'alice-main');
    const bob = await loadOrCreateIdentityForDevice(332, 'bob-main');

    const sessionStatus = await ensureRatchetSessionsForRecipients(
      331,
      'alice-main',
      alice,
      [331, 332],
      async (userID) => {
        if (userID === 331) {
          return toBundleList(331, 'alice', [alice]);
        }
        if (userID === 332) {
          return toBundleList(332, 'bob', [bob]);
        }
        throw new Error(`unexpected recipient ${userID}`);
      },
    );

    const fullPayload = await encryptForRecipients(
      'mailbox-only-envelope',
      331,
      'alice-main',
      alice,
      sessionStatus.readyRecipients,
    );
    const bobOnlyPayload = {
      ...fullPayload,
      wrappedKeys: {
        '332:bob-main': fullPayload.wrappedKeys['332:bob-main'],
      },
    };

    await expect(decryptPayload(bobOnlyPayload, 332, 'bob-main', 331, 'alice-main', bob)).resolves.toBe(
      'mailbox-only-envelope',
    );
  });

  it('refills a missing V4 mailbox envelope without changing message ciphertext', async () => {
    const aliceMobile = await loadOrCreateIdentityForDevice(333, 'alice-mobile');
    const aliceDesktop = await loadOrCreateIdentityForDevice(333, 'alice-desktop');
    const bob = await loadOrCreateIdentityForDevice(334, 'bob-main');

    const sessionStatus = await ensureRatchetSessionsForRecipients(
      333,
      'alice-mobile',
      aliceMobile,
      [333, 334],
      async (userID) => {
        if (userID === 333) {
          return toBundleList(333, 'alice', [aliceMobile, aliceDesktop]);
        }
        if (userID === 334) {
          return toBundleList(334, 'bob', [bob]);
        }
        throw new Error(`unexpected recipient ${userID}`);
      },
    );

    const payload = await encryptForRecipients(
      'mailbox-refill',
      333,
      'alice-mobile',
      aliceMobile,
      sessionStatus.readyRecipients.filter((recipient) => recipient.deviceID !== 'alice-desktop'),
    );
    await expect(decryptPayload(payload, 333, 'alice-desktop', 333, 'alice-mobile', aliceDesktop)).rejects.toThrow(
      'no wrapped key for this user',
    );

    const { rawContentKey } = await decryptPayloadWithContentKey(
      payload,
      333,
      'alice-mobile',
      333,
      'alice-mobile',
      aliceMobile,
    );
    await ensureRatchetSessionsForRecipients(
      333,
      'alice-mobile',
      aliceMobile,
      [333],
      async () => toBundleList(333, 'alice', [aliceMobile, aliceDesktop]),
    );
    const desktopWrappedKey = await wrapContentKeyForRecipient(
      333,
      'alice-mobile',
      aliceMobile,
      { userID: 333, deviceID: 'alice-desktop' },
      rawContentKey,
    );
    const refilled = {
      ...payload,
      wrappedKeys: {
        '333:alice-desktop': desktopWrappedKey,
      },
    };

    await expect(decryptPayload(refilled, 333, 'alice-desktop', 333, 'alice-mobile', aliceDesktop)).resolves.toBe(
      'mailbox-refill',
    );
  });

  it('rejects wrapped keys rebound to another recipient address', async () => {
    const alice = await loadOrCreateIdentityForDevice(341, 'alice-main');
    const bob = await loadOrCreateIdentityForDevice(342, 'bob-main');

    const sessionStatus = await ensureRatchetSessionsForRecipients(
      341,
      'alice-main',
      alice,
      [342],
      async (userID) => {
        if (userID === 342) {
          return toBundleList(342, 'bob', [bob]);
        }
        throw new Error(`unexpected recipient ${userID}`);
      },
    );

    const payload = await encryptForRecipients(
      'aad-check',
      341,
      'alice-main',
      alice,
      sessionStatus.readyRecipients,
    );
    const tampered = {
      ...payload,
      wrappedKeys: {
        '342:bob-main': {
          ...payload.wrappedKeys['342:bob-main'],
          recipientAad: '999:mallory',
        },
      },
    };

    await expect(decryptPayload(tampered, 342, 'bob-main', 341, 'alice-main', bob)).rejects.toThrow(
      'wrapped key recipient binding mismatch',
    );
  });

  it('does not advance a prekey receive session until message content decrypts', async () => {
    const alice = await loadOrCreateIdentityForDevice(351, 'alice-main');
    const bob = await loadOrCreateIdentityForDevice(352, 'bob-main');

    const sessionStatus = await ensureRatchetSessionsForRecipients(
      351,
      'alice-main',
      alice,
      [352],
      async (userID) => {
        if (userID === 352) {
          return toBundleList(352, 'bob', [bob]);
        }
        throw new Error(`unexpected recipient ${userID}`);
      },
    );

    const payload = await encryptForRecipients(
      'content-auth-check',
      351,
      'alice-main',
      alice,
      sessionStatus.readyRecipients,
    );
    const tampered = await signPayloadForTest({
      ...payload,
      messageIv: toBase64(crypto.getRandomValues(new Uint8Array(12))),
    }, alice.signingPrivateKey);

    await expect(decryptPayload(tampered, 352, 'bob-main', 351, 'alice-main', bob)).rejects.toThrow();
    await expect(decryptPayload(payload, 352, 'bob-main', 351, 'alice-main', bob)).resolves.toBe(
      'content-auth-check',
    );
  });

  it('rebuilds the self session deterministically when its record is dropped', async () => {
    const alice = await loadOrCreateIdentityForDevice(401, 'alice-only-device');
    const sessionStatus = await ensureRatchetSessionsForRecipients(
      401,
      'alice-only-device',
      alice,
      [401],
      async (userID) => {
        if (userID === 401) {
          return toBundleList(401, 'alice', [alice]);
        }
        throw new Error(`unexpected recipient ${userID}`);
      },
    );
    expect(sessionStatus.readyRecipients).toHaveLength(1);

    const firstSession = await ensureSelfSession(401, 'alice-only-device', alice);
    const firstRoot = firstSession.rootKey;
    const firstSendChain = firstSession.sendChainKey;

    // Simulate a partial IDB loss: the session record disappears while the
    // identity record stays behind. The next ensureSelfSession call should
    // derive an identical root/chain pair from the deterministic seed.
    await resetRatchetSession(401, 'alice-only-device', 401, 'alice-only-device');
    const rebuiltSession = await ensureSelfSession(401, 'alice-only-device', alice);

    expect(rebuiltSession.rootKey).toBe(firstRoot);
    expect(rebuiltSession.sendChainKey).toBe(firstSendChain);
    expect(rebuiltSession.isSelfSession).toBe(true);
  });
});
