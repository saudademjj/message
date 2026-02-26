export const SECURE_DB_NAME = 'e2ee-chat-secure-store';
export const SECURE_DB_VERSION = 2;
export const IDENTITY_STORE = 'identities';
export const SESSION_STORE = 'ratchet_sessions';

export const WRAP_INFO = new TextEncoder().encode('e2ee-chat-wrap-v1');
export const WRAP_SALT = new Uint8Array(32);

export const DR_SESSION_VERSION = 1;
export const DR_RK_INFO = 'e2ee-chat-dr-rk-v1';
export const DR_ROOT_INFO = 'e2ee-chat-dr-root-v1';
export const DR_MAX_SKIP = 300;
export const DR_MAX_SKIPPED_CACHE = 600;
export const SIGNAL_X3DH_INFO = 'signal-x3dh-v1';
export const SIGNAL_INITIATOR_CHAIN_INFO = 'signal-chain-initiator-v1';
export const SIGNAL_RESPONDER_CHAIN_INFO = 'signal-chain-responder-v1';

export const DEFAULT_KEY_MAX_AGE_MS = 4 * 60 * 60 * 1000;
export const DEFAULT_KEY_HISTORY_LIMIT = 6;
export const SIGNED_PREKEY_HISTORY_LIMIT = 5;
export const ONE_TIME_PREKEY_TARGET = 96;
