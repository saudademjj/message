import { beforeEach, describe, expect, it } from 'vitest';
import {
  decryptPayload,
  encryptForRecipients,
  ensureRatchetSessionsForRecipients,
  loadOrCreateIdentity,
  rotateIdentityIfNeeded,
  toSignalPreKeyBundleUpload,
  type SignalPreKeyBundle,
} from './index';

async function clearSecureDB(): Promise<void> {
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase('e2ee-chat-secure-store');
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

function toBundle(userID: number, username: string, identity: Awaited<ReturnType<typeof loadOrCreateIdentity>>): SignalPreKeyBundle {
  const upload = toSignalPreKeyBundleUpload(identity);
  return {
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

describe('signal core ratchet flows', () => {
  beforeEach(async () => {
    await clearSecureDB();
  });

  it('rotates signed prekey material when max age is exceeded', async () => {
    const first = await loadOrCreateIdentity(101);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const result = await rotateIdentityIfNeeded(101, 1, 6);

    expect(result.rotated).toBe(true);
    expect(result.identity.signedPreKey.keyID).not.toBe(first.signedPreKey.keyID);
  });

  it('establishes X3DH session from prekey bundle and decrypts initial message offline', async () => {
    const alice = await loadOrCreateIdentity(201);
    const bob = await loadOrCreateIdentity(202);

    await ensureRatchetSessionsForRecipients(
      201,
      alice,
      [201, 202],
      async (userID) => {
        if (userID !== 202) {
          throw new Error(`unexpected recipient ${userID}`);
        }
        return toBundle(202, 'bob', bob);
      },
    );

    const payload = await encryptForRecipients('hello bob', 201, alice, [201, 202]);

    const bobText = await decryptPayload(payload, 202, 201, bob);
    const aliceText = await decryptPayload(payload, 201, 201, alice);

    expect(bobText).toBe('hello bob');
    expect(aliceText).toBe('hello bob');
    expect(payload.wrappedKeys['202'].preKeyMessage).toBeTruthy();
  });

  it('rejects ciphertext tampering via signature verification', async () => {
    const alice = await loadOrCreateIdentity(301);
    const bob = await loadOrCreateIdentity(302);

    await ensureRatchetSessionsForRecipients(
      301,
      alice,
      [301, 302],
      async (userID) => {
        if (userID !== 302) {
          throw new Error(`unexpected recipient ${userID}`);
        }
        return toBundle(302, 'bob', bob);
      },
    );

    const payload = await encryptForRecipients('integrity-check', 301, alice, [301, 302]);
    const tampered = {
      ...payload,
      ciphertext: `${payload.ciphertext}A`,
    };

    await expect(decryptPayload(tampered, 302, 301, bob)).rejects.toThrow(
      'message signature verification failed',
    );
  });
});
