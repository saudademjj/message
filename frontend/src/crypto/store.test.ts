import { IDENTITY_STORE, SECURE_DB_NAME, SECURE_DB_VERSION, SESSION_STORE } from './constants';
import { readIdentityRecord, readSession, writeIdentityRecord, writeSession } from './store';
import type { PersistedIdentityRecord, RatchetSessionRecord } from './types';

function openSecureDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SECURE_DB_NAME, SECURE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDENTITY_STORE)) {
        db.createObjectStore(IDENTITY_STORE, { keyPath: 'userID' });
      }
      if (!db.objectStoreNames.contains(SESSION_STORE)) {
        db.createObjectStore(SESSION_STORE, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('failed to open secure db'));
  });
}

function deleteSecureDB(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(SECURE_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('failed to delete secure db'));
    request.onblocked = () => resolve();
  });
}

async function createECDHKeyPair() {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  ) as CryptoKeyPair;
  const publicKeyJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicKeyJwk,
  };
}

async function createECDSAKeyPair() {
  const pair = await crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify'],
  ) as CryptoKeyPair;
  const publicKeyJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return {
    privateKey: pair.privateKey,
    publicKey: pair.publicKey,
    publicKeyJwk,
  };
}

async function createIdentityRecord(userID: number, deviceID: string): Promise<PersistedIdentityRecord> {
  const identityPair = await createECDHKeyPair();
  const signingPair = await createECDSAKeyPair();
  const signedPreKeyPair = await createECDHKeyPair();
  const oneTimePreKeyPair = await createECDHKeyPair();

  return {
    userID,
    deviceID,
    identityPrivateKey: identityPair.privateKey,
    identityPublicKey: identityPair.publicKey,
    identityPublicKeyJwk: identityPair.publicKeyJwk,
    signingPrivateKey: signingPair.privateKey,
    signingPublicKey: signingPair.publicKey,
    signingPublicKeyJwk: signingPair.publicKeyJwk,
    signedPreKeys: [{
      keyID: 1,
      createdAt: new Date().toISOString(),
      publicKeyJwk: signedPreKeyPair.publicKeyJwk,
      privateKey: signedPreKeyPair.privateKey,
      signature: 'test-signature',
    }],
    activeSignedPreKeyID: 1,
    oneTimePreKeys: [{
      keyID: 1,
      createdAt: new Date().toISOString(),
      publicKeyJwk: oneTimePreKeyPair.publicKeyJwk,
      privateKey: oneTimePreKeyPair.privateKey,
    }],
    nextOneTimePreKeyID: 2,
    updatedAt: new Date().toISOString(),
  };
}

async function createSessionRecord(
  userID: number,
  localDeviceID: string,
  peerUserID: number,
  peerDeviceID: string,
): Promise<RatchetSessionRecord> {
  const sendPair = await createECDHKeyPair();
  const recvPair = await createECDHKeyPair();
  const peerIdentity = await createECDHKeyPair();
  const peerSigning = await createECDSAKeyPair();
  return {
    id: `${userID}:${localDeviceID}:${peerUserID}:${peerDeviceID}`,
    userID,
    localDeviceID,
    peerUserID,
    peerDeviceID,
    status: 'ready',
    rootKey: 'root-key-b64',
    sendChainKey: 'send-chain-key-b64',
    recvChainKey: 'recv-chain-key-b64',
    sendCount: 0,
    recvCount: 0,
    previousSendCount: 0,
    skipped: {},
    dhSendPrivate: sendPair.privateKey,
    dhSendPublicJwk: sendPair.publicKeyJwk,
    dhRecvPublicJwk: recvPair.publicKeyJwk,
    peerIdentityPublicKeyJwk: peerIdentity.publicKeyJwk,
    peerIdentitySigningPublicKeyJwk: peerSigning.publicKeyJwk,
    pendingPreKey: null,
    isSelfSession: false,
    updatedAt: new Date().toISOString(),
  };
}

describe('crypto secure store', () => {
  beforeEach(async () => {
    await deleteSecureDB();
  });

  afterAll(async () => {
    await deleteSecureDB();
  });

  it('writes and reads identity records with non-exportable private keys', async () => {
    const record = await createIdentityRecord(9001, 'device-9001');

    await writeIdentityRecord(record);
    const loaded = await readIdentityRecord(9001);

    expect(loaded).not.toBeNull();
    expect(loaded?.userID).toBe(9001);
    expect(loaded?.deviceID).toBe('device-9001');
    expect(loaded?.identityPrivateKey.extractable).toBe(false);
    expect(loaded?.signingPrivateKey.extractable).toBe(false);
    expect(loaded?.signedPreKeys[0]?.privateKey.extractable).toBe(false);
  });

  it('writes and reads ratchet sessions with non-exportable private keys', async () => {
    const session = await createSessionRecord(9001, 'device-9001', 9002, 'device-9002');

    await writeSession(session);
    const loaded = await readSession(9001, 'device-9001', 9002, 'device-9002');

    expect(loaded).not.toBeNull();
    expect(loaded?.id).toBe('9001:device-9001:9002:device-9002');
    expect(loaded?.dhSendPrivate.extractable).toBe(false);
  });

  it('fails closed when secure store is unavailable during identity read', async () => {
    const db = await openSecureDB();
    db.close();

    const openSpy = vi.spyOn(indexedDB, 'open').mockImplementation((() => {
      throw new Error('indexeddb unavailable');
    }) as unknown as typeof indexedDB.open);

    try {
      await expect(readIdentityRecord(9001)).rejects.toThrow('本地安全密钥存储不可用');
    } finally {
      openSpy.mockRestore();
    }
  });

  it('fails closed when secure store is unavailable during session write', async () => {
    const session = await createSessionRecord(9001, 'device-9001', 9002, 'device-9002');
    const openSpy = vi.spyOn(indexedDB, 'open').mockImplementation((() => {
      throw new Error('indexeddb unavailable');
    }) as unknown as typeof indexedDB.open);

    try {
      await expect(writeSession(session)).rejects.toThrow('本地安全密钥存储不可用');
    } finally {
      openSpy.mockRestore();
    }
  });
});
