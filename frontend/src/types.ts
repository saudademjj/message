export interface User {
  id: number;
  username: string;
  role: 'admin' | 'user';
  lastReadMessageId?: number;
}

export interface Room {
  id: number;
  name: string;
  createdAt: string;
  lastMessageId: number | null;
  lastActivityAt: string;
  unreadCount: number;
}

export interface DeviceSnapshot {
  deviceId: string;
  deviceName: string;
  sessionVersion: number;
  createdAt: string;
  lastSeenAt: string;
  trustStatus: 'approved' | 'pending';
  pendingSince?: string | null;
  approvedAt?: string | null;
  revokedAt?: string | null;
  current: boolean;
}

export interface WrappedKey {
  iv: string;
  wrappedKey: string;
  recipientAad?: string;
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
  oneTimePreKeyConsumed?: boolean;
  oneTimePreKeyLow?: boolean;
  oneTimePreKeysLeft?: number;
}

export interface SignalPreKeyBundleList {
  userId: number;
  username?: string;
  devices: SignalPreKeyBundle[];
  activeDeviceCount: number;
  readyDeviceCount: number;
  missingDeviceCount: number;
  updatedAt?: string;
}

export interface SafetyNumberHistoryEntry {
  deviceId?: string;
  fingerprint: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface SafetyNumberDeviceSnapshot {
  deviceId: string;
  deviceName?: string;
  identityKeyJwk: JsonWebKey;
  identityFingerprint: string;
  identityUpdatedAt: string;
  safetyNumber: string;
  targetHistory: SafetyNumberHistoryEntry[];
}

export interface SafetyNumberSnapshot {
  localUserId: number;
  localDeviceId?: string;
  targetUserId: number;
  targetDeviceId?: string;
  targetDeviceName?: string;
  localIdentityKeyJwk: JsonWebKey;
  targetIdentityKeyJwk: JsonWebKey;
  localIdentityFingerprint: string;
  targetIdentityFingerprint: string;
  localIdentityUpdatedAt: string;
  targetIdentityUpdatedAt: string;
  safetyNumber: string;
  targetHistory: SafetyNumberHistoryEntry[];
  devices?: SafetyNumberDeviceSnapshot[];
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

export interface EnvelopeRefillRequestFrame {
  type: 'envelope_refill_request';
  roomId: number;
  fromUserId: number;
  fromUsername: string;
  fromDeviceId?: string;
  toUserId: number;
  toDeviceId?: string;
  messageIds: number[];
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

export interface RoomSummariesFrame {
  type: 'room_summaries';
  rooms: Room[];
}

export interface RoomSummaryUpdateFrame {
  type: 'room_summary_update';
  room: Room;
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

export interface ProtocolErrorFrame {
  type: 'protocol_error';
  roomId: number;
  code: 'legacy_payload_not_supported' | 'invalid_payload_format' | 'ciphertext_rate_limited' | 'websocket_auth_expired';
  message: string;
}

export interface UserBundleChangedFrame {
  type: 'user_bundle_changed';
  userId: number;
  deviceId: string;
  identityFingerprint: string;
  updatedAt: string;
}
