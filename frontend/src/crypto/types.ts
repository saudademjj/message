export type PersistedSignedPreKey = {
  keyID: number;
  createdAt: string;
  publicKeyJwk: JsonWebKey;
  privateKey: CryptoKey;
  signature: string;
};

export type PersistedOneTimePreKey = {
  keyID: number;
  createdAt: string;
  publicKeyJwk: JsonWebKey;
  privateKey: CryptoKey;
};

export type PersistedIdentityRecord = {
  userID: number;
  deviceID: string;
  identityPrivateKey: CryptoKey;
  identityPublicKey: CryptoKey;
  identityPublicKeyJwk: JsonWebKey;
  signingPrivateKey: CryptoKey;
  signingPublicKey: CryptoKey;
  signingPublicKeyJwk: JsonWebKey;
  signedPreKeys: PersistedSignedPreKey[];
  activeSignedPreKeyID: number;
  oneTimePreKeys: PersistedOneTimePreKey[];
  nextOneTimePreKeyID: number;
  updatedAt: string;
};

export type SessionStatus = 'ready';

export type PendingPreKeyState = {
  identityKeyJwk: JsonWebKey;
  identitySigningPublicKeyJwk: JsonWebKey;
  ephemeralKeyJwk: JsonWebKey;
  signedPreKeyId: number;
  oneTimePreKeyId: number | null;
  preKeyBundleUpdatedAt: string;
};

export type RatchetSessionRecord = {
  id: string;
  userID: number;
  localDeviceID: string;
  peerUserID: number;
  peerDeviceID: string;
  status: SessionStatus;
  rootKey: string;
  sendChainKey: string;
  recvChainKey: string;
  sendCount: number;
  recvCount: number;
  previousSendCount: number;
  skipped: Record<string, string>;
  dhSendPrivate: CryptoKey;
  dhSendPublicJwk: JsonWebKey;
  dhRecvPublicJwk: JsonWebKey;
  peerIdentityPublicKeyJwk: JsonWebKey;
  peerIdentitySigningPublicKeyJwk: JsonWebKey;
  pendingPreKey: PendingPreKeyState | null;
  isSelfSession: boolean;
  updatedAt: string;
};

export type Identity = {
  userID: number;
  activeKeyID: string;
  privateKey: CryptoKey;
  publicKey: CryptoKey;
  publicKeyJwk: JsonWebKey;
  signingPrivateKey: CryptoKey;
  signingPublicKey: CryptoKey;
  signingPublicKeyJwk: JsonWebKey;
  signedPreKey: PersistedSignedPreKey;
  signedPreKeys: PersistedSignedPreKey[];
  oneTimePreKeys: PersistedOneTimePreKey[];
  privateKeys: CryptoKey[];
  publicKeys: JsonWebKey[];
  rotatedAt: string;
};

export type RotationResult = {
  identity: Identity;
  rotated: boolean;
};

export type RatchetHandshakeOutgoing = {
  type: 'dr_handshake';
  toUserId: number;
  step: 'init' | 'ack';
  sessionVersion: number;
  ratchetDhPublicKeyJwk: JsonWebKey;
  identityPublicKeyJwk: JsonWebKey;
  identitySigningPublicKeyJwk: JsonWebKey;
};

export type RatchetSessionStatus = {
  readyRecipients: RecipientAddress[];
  pendingUserIDs: number[];
};

export type SignalPreKeyBundle = {
  deviceId: string;
  userId: number;
  username?: string;
  identityKeyJwk: JsonWebKey;
  identitySigningPublicKeyJwk: JsonWebKey;
  signedPreKey: {
    keyId: number;
    publicKeyJwk: JsonWebKey;
    signature: string;
    createdAt?: string;
  };
  oneTimePreKey?: {
    keyId: number;
    publicKeyJwk: JsonWebKey;
    createdAt?: string;
  };
  updatedAt?: string;
};

export type SignalPreKeyBundleList = {
  userId: number;
  username?: string;
  devices: SignalPreKeyBundle[];
  updatedAt?: string;
};

export type SignalPreKeyBundleUpload = {
  identityKeyJwk: JsonWebKey;
  identitySigningPublicKeyJwk: JsonWebKey;
  signedPreKey: {
    keyId: number;
    publicKeyJwk: JsonWebKey;
    signature: string;
  };
  oneTimePreKeys: Array<{
    keyId: number;
    publicKeyJwk: JsonWebKey;
  }>;
};

export type RecipientAddress = {
  userID: number;
  deviceID: string;
};

export type SignalBundleResolver = (userID: number) => Promise<SignalPreKeyBundleList>;
