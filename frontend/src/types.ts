export interface User {
  id: number;
  username: string;
  role: 'admin' | 'user';
}

export interface Room {
  id: number;
  name: string;
  createdAt: string;
}

export interface DeviceSnapshot {
  deviceId: string;
  deviceName: string;
  sessionVersion: number;
  createdAt: string;
  lastSeenAt: string;
  revokedAt?: string | null;
  current: boolean;
}

export interface WrappedKey {
  iv: string;
  wrappedKey: string;
  ratchetDhPublicKeyJwk?: JsonWebKey;
  messageNumber?: number;
  previousChainLength?: number;
  sessionVersion?: number;
  preKeyMessage?: {
    identityKeyJwk: JsonWebKey;
    identitySigningPublicKeyJwk?: JsonWebKey;
    ephemeralKeyJwk: JsonWebKey;
    signedPreKeyId: number;
    oneTimePreKeyId?: number;
    preKeyBundleUpdatedAt?: string;
  };
}

export interface CipherPayload {
  version: number;
  ciphertext: string;
  messageIv: string;
  wrappedKeys: Record<string, WrappedKey>;
  senderPublicKeyJwk: JsonWebKey;
  senderSigningPublicKeyJwk?: JsonWebKey;
  signature?: string;
  contentType?: string;
  senderDeviceId?: string;
  encryptionScheme?: string;
}

export interface ChatMessage {
  id: number;
  roomId: number;
  senderId: number;
  senderUsername: string;
  createdAt: string;
  editedAt?: string | null;
  revokedAt?: string | null;
  payload: CipherPayload;
}

export interface Peer {
  userId: number;
  username: string;
  deviceId: string;
  deviceName?: string;
  publicKeyJwk: JsonWebKey;
  signingPublicKeyJwk?: JsonWebKey;
}

export interface SignalSignedPreKey {
  keyId: number;
  publicKeyJwk: JsonWebKey;
  signature: string;
  createdAt?: string;
}

export interface SignalOneTimePreKey {
  keyId: number;
  publicKeyJwk: JsonWebKey;
  createdAt?: string;
}

export interface SignalPreKeyBundle {
  deviceId: string;
  userId: number;
  username?: string;
  identityKeyJwk: JsonWebKey;
  identitySigningPublicKeyJwk: JsonWebKey;
  signedPreKey: SignalSignedPreKey;
  oneTimePreKey?: SignalOneTimePreKey;
  updatedAt?: string;
}

export interface SignalPreKeyBundleList {
  userId: number;
  username?: string;
  devices: SignalPreKeyBundle[];
  updatedAt?: string;
}

export interface SafetyNumberHistoryEntry {
  fingerprint: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface SafetyNumberSnapshot {
  localUserId: number;
  targetUserId: number;
  localIdentityKeyJwk: JsonWebKey;
  targetIdentityKeyJwk: JsonWebKey;
  localIdentityFingerprint: string;
  targetIdentityFingerprint: string;
  localIdentityUpdatedAt: string;
  targetIdentityUpdatedAt: string;
  safetyNumber: string;
  targetHistory: SafetyNumberHistoryEntry[];
}

export interface RatchetHandshakeFrame {
  type: 'dr_handshake';
  roomId: number;
  fromUserId: number;
  fromUsername: string;
  toUserId: number;
  step: 'init' | 'ack';
  sessionVersion?: number;
  ratchetDhPublicKeyJwk: JsonWebKey;
  identityPublicKeyJwk: JsonWebKey;
  identitySigningPublicKeyJwk: JsonWebKey;
}

export interface DecryptAckFrame {
  type: 'decrypt_ack';
  roomId: number;
  messageId: number;
  fromUserId: number;
  fromUsername: string;
}

export interface DecryptRecoveryRequestFrame {
  type: 'decrypt_recovery_request';
  roomId: number;
  messageId: number;
  fromUserId: number;
  fromUsername: string;
  fromDeviceId?: string;
  toUserId: number;
  toDeviceId?: string;
  action?: 'resync';
}

export interface DecryptRecoveryPayloadFrame {
  type: 'decrypt_recovery_payload';
  roomId: number;
  messageId: number;
  fromUserId: number;
  fromUsername: string;
  fromDeviceId?: string;
  toUserId: number;
  toDeviceId?: string;
  payload: CipherPayload;
}

export interface TypingStatusFrame {
  type: 'typing_status';
  roomId: number;
  fromUserId: number;
  fromUsername: string;
  isTyping: boolean;
}

export interface ReadReceiptFrame {
  type: 'read_receipt';
  roomId: number;
  fromUserId: number;
  fromUsername: string;
  upToMessageId: number;
}

export interface MessageUpdateFrame {
  type: 'message_update';
  roomId: number;
  messageId: number;
  mode: 'edit' | 'revoke';
  fromUserId: number;
  fromUsername: string;
  editedAt?: string;
  revokedAt?: string;
  payload?: CipherPayload;
}
