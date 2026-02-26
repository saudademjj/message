import { IDENTITY_STORE, SECURE_DB_NAME, SECURE_DB_VERSION, SESSION_STORE } from './constants';
import { readIdentityRecord, readSession } from './store';

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

function putRecord(db: IDBDatabase, storeName: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error(`failed to put record into ${storeName}`));
    tx.objectStore(storeName).put(value);
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

describe('crypto store jwk compatibility', () => {
  beforeEach(async () => {
    await deleteSecureDB();
  });

  afterAll(async () => {
    await deleteSecureDB();
  });

  it('hydrates identity record from jwk-only persistence format', async () => {
    const identityPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits'],
    ) as CryptoKeyPair;
    const signingPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    ) as CryptoKeyPair;
    const signedPreKeyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits'],
    ) as CryptoKeyPair;
    const oneTimePreKeyPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits'],
    ) as CryptoKeyPair;

    const db = await openSecureDB();
    try {
      await putRecord(db, IDENTITY_STORE, {
        userID: 7001,
        deviceID: 'device-7001',
        identityPrivateKeyJwk: await crypto.subtle.exportKey('jwk', identityPair.privateKey),
        identityPublicKeyJwk: await crypto.subtle.exportKey('jwk', identityPair.publicKey),
        signingPrivateKeyJwk: await crypto.subtle.exportKey('jwk', signingPair.privateKey),
        signingPublicKeyJwk: await crypto.subtle.exportKey('jwk', signingPair.publicKey),
        signedPreKeys: [{
          keyID: 11,
          createdAt: '2026-02-26T00:00:00.000Z',
          publicKeyJwk: await crypto.subtle.exportKey('jwk', signedPreKeyPair.publicKey),
          privateKeyJwk: await crypto.subtle.exportKey('jwk', signedPreKeyPair.privateKey),
          signature: 'signature-placeholder',
        }],
        activeSignedPreKeyID: 11,
        oneTimePreKeys: [{
          keyID: 21,
          createdAt: '2026-02-26T00:00:00.000Z',
          publicKeyJwk: await crypto.subtle.exportKey('jwk', oneTimePreKeyPair.publicKey),
          privateKeyJwk: await crypto.subtle.exportKey('jwk', oneTimePreKeyPair.privateKey),
        }],
        nextOneTimePreKeyID: 22,
        updatedAt: '2026-02-26T00:00:00.000Z',
      });
    } finally {
      db.close();
    }

    const record = await readIdentityRecord(7001);

    expect(record).not.toBeNull();
    expect(record?.userID).toBe(7001);
    expect(record?.signedPreKeys).toHaveLength(1);
    expect(record?.oneTimePreKeys).toHaveLength(1);
    expect(record?.identityPrivateKey).toBeInstanceOf(CryptoKey);
    expect(record?.signingPrivateKey).toBeInstanceOf(CryptoKey);
  });

  it('hydrates ratchet session from jwk-only persistence format', async () => {
    const dhSendPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits'],
    ) as CryptoKeyPair;
    const peerIdentityPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits'],
    ) as CryptoKeyPair;
    const peerSigningPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    ) as CryptoKeyPair;
    const remoteDhPair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits'],
    ) as CryptoKeyPair;

    const db = await openSecureDB();
    try {
      await putRecord(db, SESSION_STORE, {
        id: '7001:7002',
        userID: 7001,
        peerUserID: 7002,
        rootKey: 'root-key-b64',
        sendChainKey: 'send-chain-key-b64',
        recvChainKey: 'recv-chain-key-b64',
        sendCount: 3,
        recvCount: 4,
        previousSendCount: 2,
        skipped: {},
        dhSendPrivateJwk: await crypto.subtle.exportKey('jwk', dhSendPair.privateKey),
        dhSendPublicJwk: await crypto.subtle.exportKey('jwk', dhSendPair.publicKey),
        dhRecvPublicJwk: await crypto.subtle.exportKey('jwk', remoteDhPair.publicKey),
        peerIdentityPublicKeyJwk: await crypto.subtle.exportKey('jwk', peerIdentityPair.publicKey),
        peerIdentitySigningPublicKeyJwk: await crypto.subtle.exportKey('jwk', peerSigningPair.publicKey),
        pendingPreKey: null,
        isSelfSession: false,
        updatedAt: '2026-02-26T00:00:00.000Z',
      });
    } finally {
      db.close();
    }

    const session = await readSession(7001, 7002);

    expect(session).not.toBeNull();
    expect(session?.id).toBe('7001:7002');
    expect(session?.dhSendPrivate).toBeInstanceOf(CryptoKey);
    expect(session?.peerIdentityPublicKeyJwk?.crv).toBe('P-256');
  });
});
