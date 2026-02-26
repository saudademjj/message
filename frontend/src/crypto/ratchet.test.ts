import { beforeEach, describe, expect, it } from 'vitest';
import {
  decryptPayload,
  encryptForRecipients,
  ensureRatchetSessionsForRecipients,
  loadOrCreateIdentityForDevice,
  rotateIdentityIfNeeded,
  toSignalPreKeyBundleUpload,
  type SignalPreKeyBundle,
  type SignalPreKeyBundleList,
} from './index';

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
): SignalPreKeyBundle {
  const upload = toSignalPreKeyBundleUpload(identity);
  return {
    deviceId: identity.activeKeyID,
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

function toBundleList(
  userID: number,
  username: string,
  identities: Array<Awaited<ReturnType<typeof loadOrCreateIdentityForDevice>>>,
): SignalPreKeyBundleList {
  return {
    userId: userID,
    username,
    devices: identities.map((identity) => toBundle(userID, username, identity)),
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
});
