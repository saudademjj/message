import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from 'react';
import {
  decryptPayloadWithContentKey,
  ensureRatchetSessionsForRecipients,
  encryptForRecipients,
  resetRatchetSession,
  signDecryptAck,
  wrapContentKeyForRecipient,
  type Identity,
} from '../crypto';
import { buildRecipientAddress } from '../crypto/utils';
import type { ApiClient } from '../api';
import type { AuthSession } from '../contexts/AuthContext';
import type { UIMessage } from '../app/appTypes';
import {
  buildRecoveryRequestKey,
  estimatePendingWidth,
  formatTimelineLabel,
  parseQuotedMessage,
  toLocalDateParts,
} from '../app/helpers';
import { useTimelineItems } from './useTimelineItems';
import { useChatStore } from '../stores/chatStore';
import { loadCachedContentKeys, loadCachedPlaintexts, loadOutgoingContentKey, persistDecryptedPlaintext } from '../secureMessageStore';
import { markOutgoingPlaintextDelivered, readOutgoingPlaintext } from '../outgoingPlaintextCache';
import { isExpectedReadUser } from '../readState';
import {
  clearResyncRequest,
  rememberResyncRequest,
  shouldCooldownResyncRequest,
} from '../resyncRecoveryStore';
import type {
  ChatMessage,
  DecryptRecoveryPayloadFrame,
  DecryptRecoveryRequestFrame,
  EnvelopeRefillRequestFrame,
  MessageUpdateFrame,
  Peer,
  ProtocolErrorFrame,
  ReadReceiptFrame,
  Room,
  TypingStatusFrame,
  User,
  UserBundleChangedFrame,
} from '../types';

const MESSAGE_PAGE_SIZE = 100;
const TYPING_IDLE_MS = 1800;
const READ_RECEIPT_THROTTLE_MS = 1200;
const SIGNAL_BUNDLE_RETRY_BASE_MS = 2000;
const SIGNAL_BUNDLE_RETRY_MAX_MS = 30000;
const RESYNC_SWEEP_INTERVAL_MS = 5000;
const RESYNC_SWEEP_BATCH_SIZE = 50;
const RESYNC_REQUEST_TIMEOUT_MS = 20000;

type UseMessagesArgs = {
  api: ApiClient;
  auth: AuthSession | null;
  identity: Identity | null;
  rooms: Room[];
  selectedRoomID: number | null;
  roomMembers: User[];
  wsConnected: boolean;
  sendJSON: (frame: unknown) => boolean;
  connect: (params: { roomID: number }) => void;
  disconnect: (reason?: string) => void;
  subscribeMessage: (listener: (frame: Record<string, unknown>) => void) => () => void;
  subscribeOpen: (listener: () => void) => () => void;
  handshakeTick: number;
  bumpHandshakeTick: () => void;
  resolveSignalBundle: (targetUserID: number) => Promise<{
    userId: number;
    username?: string;
    devices: Array<{
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
    }>;
    activeDeviceCount: number;
    readyDeviceCount: number;
    missingDeviceCount: number;
    updatedAt?: string;
  }>;
  reportError: (reason: unknown, fallback: string) => void;
  setInfo: Dispatch<SetStateAction<string>>;
  setError: Dispatch<SetStateAction<string>>;
  notificationPermission: NotificationPermission;
  onRoomSwitch?: () => void;
};

type UseMessagesResult = {
  messages: UIMessage[];
  messageReadReceipts: Record<number, number[]>;
  hasMoreHistory: boolean;
  historyLoading: boolean;
  isRoomSwitching: boolean;
  peers: Record<string, Peer>;
  onlinePeers: Peer[];
  peerCount: number;
  peerSafetyNumbers: Record<string, string>;
  typingIndicatorText: string;
  roomSearchQuery: string;
  setRoomSearchQuery: Dispatch<SetStateAction<string>>;
  roomSearchMatches: number[];
  activeSearchResultIndex: number;
  setActiveSearchResultIndex: Dispatch<SetStateAction<number>>;
  messageListRef: React.RefObject<HTMLDivElement | null>;
  messageEndRef: React.RefObject<HTMLDivElement | null>;
  focusMessageID: number | null;
  lastReadMessageID: number;
  unreadIncomingCount: number;
  timelineItems: ReturnType<typeof useTimelineItems<UIMessage>>;
  emitTypingStatus: (isTyping: boolean) => void;
  handleLoadMoreHistory: () => void;
  handleMessageListScroll: () => void;
  handleJumpToLatest: () => void;
  handleFocusMessageHandled: (found: boolean) => void;
  handleSearchPrev: () => void;
  handleSearchNext: () => void;
  handleEditMessage: (message: UIMessage) => Promise<void>;
  handleRevokeMessage: (messageID: number) => void;
  handleRequestDecryptRecovery: (messageID: number, senderUserID: number) => void;
  resetReplyAndFocusState: () => void;
  setFocusMessageID: Dispatch<SetStateAction<number | null>>;
};

export function findFirstUnreadIncomingMessageID(
  messages: Array<Pick<ChatMessage, 'id' | 'senderId'>>,
  authUserID: number,
  lastReadMessageID: number,
): number | null {
  const firstUnread = messages.find(
    (message) =>
      message.id > lastReadMessageID
      && message.senderId !== authUserID,
  );
  return firstUnread?.id ?? null;
}

export function compareMessagesForTimeline(left: UIMessage, right: UIMessage): number {
  const leftIsLocal = Boolean(left.localQueueID);
  const rightIsLocal = Boolean(right.localQueueID);
  if (leftIsLocal !== rightIsLocal) {
    return leftIsLocal ? 1 : -1;
  }

  const leftTime = Date.parse(left.createdAt);
  const rightTime = Date.parse(right.createdAt);
  const leftSortTime = Number.isNaN(leftTime) ? 0 : leftTime;
  const rightSortTime = Number.isNaN(rightTime) ? 0 : rightTime;
  if (leftSortTime !== rightSortTime) {
    return leftSortTime - rightSortTime;
  }

  return left.id - right.id;
}

export function findLatestServerMessageID(messages: UIMessage[]): number | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message.localQueueID && message.id > 0) {
      return message.id;
    }
  }
  return null;
}

export function mergeMessagesByID(
  previous: UIMessage[],
  incoming: UIMessage[],
): UIMessage[] {
  if (incoming.length === 0) {
    return previous;
  }
  const merged = new Map<number, UIMessage>();
  for (const message of previous) {
    merged.set(message.id, message);
  }
  for (const message of incoming) {
    const current = merged.get(message.id);
    if (current?.decryptState === 'ok' && message.decryptState !== 'ok') {
      continue;
    }
    merged.set(message.id, message);
  }
  return [...merged.values()].sort(compareMessagesForTimeline);
}

export async function fetchMissingMessagesAfterCursor(
  fetchPage: (afterMessageID: number | null) => Promise<{ messages: ChatMessage[] }>,
  afterMessageID: number | null,
  pageSize: number,
): Promise<ChatMessage[]> {
  const normalizedPageSize = Math.max(1, Math.floor(pageSize));
  const collected: ChatMessage[] = [];
  let cursor = afterMessageID && afterMessageID > 0 ? afterMessageID : null;

  while (true) {
    const { messages: pageMessages } = await fetchPage(cursor);
    if (pageMessages.length === 0) {
      return collected;
    }
    const sorted = [...pageMessages].sort((left, right) => left.id - right.id);
    collected.push(...sorted);
    if (sorted.length < normalizedPageSize) {
      return collected;
    }
    const nextCursor = sorted[sorted.length - 1]?.id ?? 0;
    if (nextCursor <= (cursor ?? 0)) {
      return collected;
    }
    cursor = nextCursor;
  }
}

export function useMessages({
  api,
  auth,
  identity,
  rooms,
  selectedRoomID,
  roomMembers,
  wsConnected,
  sendJSON,
  connect,
  disconnect,
  subscribeMessage,
  handshakeTick,
  bumpHandshakeTick,
  resolveSignalBundle,
  reportError,
  setInfo,
  setError,
  notificationPermission,
  onRoomSwitch,
  subscribeOpen,
}: UseMessagesArgs): UseMessagesResult {
  const storedMessages = useChatStore((state) => state.messages);
  const localDraftMessages = useChatStore((state) => state.localDraftMessages);
  const setMessages = useChatStore((state) => state.setMessages);
  const setLocalDraftMessages = useChatStore((state) => state.setLocalDraftMessages);
  const messageReadReceipts = useChatStore((state) => state.messageReadReceipts);
  const setMessageReadReceipts = useChatStore((state) => state.setMessageReadReceipts);
  const setRoomMembers = useChatStore((state) => state.setRoomMembers);
  const setRooms = useChatStore((state) => state.setRooms);
  const setLocalReadCursor = useChatStore((state) => state.setLocalReadCursor);
  const peers = useChatStore((state) => state.peers);
  const setPeers = useChatStore((state) => state.setPeers);

  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [isRoomSwitching, setIsRoomSwitching] = useState(false);
  const [typingUsers, setTypingUsers] = useState<Record<number, string>>({});
  const [roomSearchQuery, setRoomSearchQuery] = useState('');
  const [activeSearchResultIndex, setActiveSearchResultIndex] = useState(0);
  const [focusMessageID, setFocusMessageID] = useState<number | null>(null);
  const [unreadIncomingCount, setUnreadIncomingCount] = useState(0);
  const [peerSafetyNumbers, setPeerSafetyNumbers] = useState<Record<string, string>>({});
  const [firstUnreadMessageID, setFirstUnreadMessageID] = useState<number | null>(null);
  const [lastReadMessageID, setLastReadMessageID] = useState(0);

  const messageListRef = useRef<HTMLDivElement | null>(null);
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const messagesRef = useRef<UIMessage[]>([]);
  const loadingMoreRef = useRef(false);
  const preserveScrollRef = useRef(false);
  const scrollRestoreRef = useRef<{ scrollTop: number; scrollHeight: number } | null>(null);
  const stickToBottomRef = useRef(true);
  const lastScrolledMessageCountRef = useRef(0);
  const ackedMessageIDsRef = useRef<Set<number>>(new Set());
  const pendingAckMessageIDsRef = useRef<Set<number>>(new Set());
  const pendingResyncRecoveryRef = useRef<Map<string, DecryptRecoveryRequestFrame>>(new Map());
  const pendingResyncTimeoutRef = useRef<Map<string, number>>(new Map());
  const resyncSweepCursorRef = useRef(0);
  const historyBeforeIDRef = useRef<number | null>(null);
  const sentTypingRef = useRef(false);
  const remoteTypingTimersRef = useRef<Map<number, number>>(new Map());
  const lastReadSentAtRef = useRef(0);
  const lastReadMessageIDRef = useRef(0);
  const pendingReadReceiptRef = useRef<number | null>(null);
  const readReceiptTimerRef = useRef<number | null>(null);
  const lastPublishedSignalBundleRef = useRef('');
  const activeRoomIDRef = useRef<number | null>(selectedRoomID);
  const decryptQueueRef = useRef<Promise<void>>(Promise.resolve());
  const identityMismatchNotifiedRef = useRef(false);

  const identityBound = Boolean(
    auth
    && identity
    && identity.userID === auth.user.id
    && identity.activeKeyID === auth.device.deviceId,
  );

  const messages = useMemo(() => {
    const activeDrafts = selectedRoomID
      ? localDraftMessages.filter((message) => message.roomId === selectedRoomID)
      : [];
    return [...storedMessages, ...activeDrafts].sort(compareMessagesForTimeline);
  }, [localDraftMessages, selectedRoomID, storedMessages]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    activeRoomIDRef.current = selectedRoomID;
  }, [selectedRoomID]);

  useEffect(() => () => {
    for (const timerID of remoteTypingTimersRef.current.values()) {
      window.clearTimeout(timerID);
    }
    remoteTypingTimersRef.current.clear();
  }, []);

  useEffect(() => () => {
    for (const timerID of pendingResyncTimeoutRef.current.values()) {
      window.clearTimeout(timerID);
    }
    pendingResyncTimeoutRef.current.clear();
  }, []);

  useEffect(() => {
    if (!auth || !identity || !identityBound) {
      lastPublishedSignalBundleRef.current = '';
      identityMismatchNotifiedRef.current = false;
      return;
    }
    if (!identityBound) {
      lastPublishedSignalBundleRef.current = '';
      if (!identityMismatchNotifiedRef.current) {
        setError('本地安全身份与当前会话不一致，请刷新页面或重新登录');
        identityMismatchNotifiedRef.current = true;
      }
      return;
    }
    identityMismatchNotifiedRef.current = false;
    const bundle = {
      identityKeyJwk: identity.publicKeyJwk,
      identitySigningPublicKeyJwk: identity.signingPublicKeyJwk,
      signedPreKey: {
        keyId: identity.signedPreKey.keyID,
        publicKeyJwk: identity.signedPreKey.publicKeyJwk,
        signature: identity.signedPreKey.signature,
      },
      oneTimePreKeys: identity.oneTimePreKeys.map((item) => ({
        keyId: item.keyID,
        publicKeyJwk: item.publicKeyJwk,
      })),
    };
    const versionKey = [
      identity.activeKeyID,
      String(identity.publicKeyJwk.kty ?? ''),
      String(identity.publicKeyJwk.crv ?? ''),
      String(identity.publicKeyJwk.x ?? ''),
      String(identity.publicKeyJwk.y ?? ''),
      String(identity.signingPublicKeyJwk.kty ?? ''),
      String(identity.signingPublicKeyJwk.crv ?? ''),
      String(identity.signingPublicKeyJwk.x ?? ''),
      String(identity.signingPublicKeyJwk.y ?? ''),
      String(bundle.signedPreKey.keyId),
      bundle.signedPreKey.signature,
      String(bundle.oneTimePreKeys.length),
      String(bundle.oneTimePreKeys[0]?.keyId ?? 0),
      String(bundle.oneTimePreKeys[bundle.oneTimePreKeys.length - 1]?.keyId ?? 0),
    ].join(':');
    if (lastPublishedSignalBundleRef.current === versionKey) {
      return;
    }

    let cancelled = false;
    let retryTimer: number | null = null;
    let retryAttempt = 0;
    let reportedFailure = false;

    const scheduleRetry = () => {
      if (cancelled) {
        return;
      }
      const delay = Math.min(
        SIGNAL_BUNDLE_RETRY_MAX_MS,
        SIGNAL_BUNDLE_RETRY_BASE_MS * Math.pow(2, retryAttempt),
      );
      retryAttempt = Math.min(retryAttempt + 1, 8);
      retryTimer = window.setTimeout(() => {
        retryTimer = null;
        publishBundle();
      }, delay);
    };

    const publishBundle = () => {
      api.publishSignalPreKeyBundle(bundle)
        .then(() => {
          if (cancelled) {
            return;
          }
          lastPublishedSignalBundleRef.current = versionKey;
          retryAttempt = 0;
          reportedFailure = false;
        })
        .catch((reason: unknown) => {
          if (cancelled) {
            return;
          }
          if (!reportedFailure) {
            reportError(reason, '上传 Signal 预密钥包失败');
            reportedFailure = true;
          }
          scheduleRetry();
        });
    };

    publishBundle();

    return () => {
      cancelled = true;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
    };
  }, [api, auth, identity, identityBound, reportError, setError]);

  useEffect(() => {
    if (!auth || !identity || !identityBound) {
      setPeerSafetyNumbers({});
      return;
    }
    const peerTargets = Object.values(peers)
      .filter((peer) => peer.userId > 0 && peer.userId !== auth.user.id && peer.deviceId.trim());
    if (peerTargets.length === 0) {
      setPeerSafetyNumbers({});
      return;
    }
    let cancelled = false;
    Promise.allSettled(
      peerTargets.map(async (peer) => {
        const snapshot = await api.fetchSignalSafetyNumber(peer.userId, peer.deviceId);
        const deviceSafetyNumber = snapshot.devices?.find((device) => device.deviceId === peer.deviceId)?.safetyNumber
          ?? snapshot.safetyNumber;
        return [buildRecipientAddress(peer.userId, peer.deviceId), deviceSafetyNumber] as const;
      }),
    ).then((results) => {
      if (cancelled) {
        return;
      }
      const next: Record<string, string> = {};
      for (const result of results) {
        if (result.status === 'fulfilled') {
          const [peerAddress, safetyNumber] = result.value;
          next[peerAddress] = safetyNumber;
        }
      }
      setPeerSafetyNumbers(next);
    }).catch(() => {
      if (!cancelled) {
        setPeerSafetyNumbers({});
      }
    });
    return () => {
      cancelled = true;
    };
  }, [api, auth, identity, identityBound, peers]);

  const registerReadReceiptUpTo = useCallback((fromUserID: number, upToMessageID: number) => {
    if (!auth || fromUserID <= 0 || upToMessageID <= 0) {
      return;
    }
    // When the receipt comes from another device of the same user, advance our
    // own local read cursor and unread count instead of marking outgoing
    // messages as "read by peer".
    if (fromUserID === auth.user.id) {
      if (upToMessageID <= lastReadMessageIDRef.current) {
        return;
      }
      lastReadMessageIDRef.current = Math.max(lastReadMessageIDRef.current, upToMessageID);
      setLastReadMessageID((previous) => Math.max(previous, upToMessageID));
      if (selectedRoomID) {
        setLocalReadCursor(selectedRoomID, upToMessageID);
        setRoomMembers((previous) => previous.map((member) => {
          if (member.id !== auth.user.id) {
            return member;
          }
          return {
            ...member,
            lastReadMessageId: Math.max(member.lastReadMessageId ?? 0, upToMessageID),
          };
        }));
        setRooms((previous) => previous.map((room) => {
          if (room.id !== selectedRoomID || room.lastMessageId === null || room.lastMessageId > upToMessageID) {
            return room;
          }
          return {
            ...room,
            unreadCount: 0,
          };
        }));
      }
      return;
    }
    setMessageReadReceipts((previous) => {
      let changed = false;
      const next = { ...previous };
      for (const message of messagesRef.current) {
        if (
          message.senderId !== auth.user.id
          || message.id > upToMessageID
          || !isExpectedReadUser(message.payload?.wrappedKeys, message.senderId, fromUserID)
        ) {
          continue;
        }
        const current = next[message.id] ?? [];
        if (current.includes(fromUserID)) {
          continue;
        }
        next[message.id] = [...current, fromUserID];
        changed = true;
      }
      return changed ? next : previous;
    });
  }, [auth, selectedRoomID, setMessageReadReceipts, setLocalReadCursor, setRoomMembers, setRooms]);

  useEffect(() => {
    if (!auth || !selectedRoomID || roomMembers.length === 0) {
      return;
    }
    for (const member of roomMembers as Array<User & { lastReadMessageId?: number }>) {
      if (member.id !== auth.user.id && member.lastReadMessageId) {
        registerReadReceiptUpTo(member.id, member.lastReadMessageId);
      }
    }
  }, [auth, selectedRoomID, roomMembers, messages, registerReadReceiptUpTo]);

  const hasOnlineSenderPeer = useCallback((senderUserID: number, senderDeviceID: string): boolean => {
    if (!Number.isFinite(senderUserID) || senderUserID <= 0) {
      return false;
    }
    const deviceID = senderDeviceID.trim();
    return Object.values(peers).some((peer) => {
      if (peer.userId !== senderUserID) {
        return false;
      }
      if (!deviceID) {
        return true;
      }
      return peer.deviceId === deviceID;
    });
  }, [peers]);

  const clearPendingRecoveryRequest = useCallback((
    messageID: number,
    senderUserID: number,
  ) => {
    if (!auth || !selectedRoomID || messageID <= 0 || senderUserID <= 0) {
      return;
    }
    const keyPrefix = `${selectedRoomID}:${auth.user.id}:${messageID}:`;
    for (const key of [...pendingResyncRecoveryRef.current.keys()]) {
      if (!key.startsWith(keyPrefix)) {
        continue;
      }
      pendingResyncRecoveryRef.current.delete(key);
      const timerID = pendingResyncTimeoutRef.current.get(key);
      if (typeof timerID === 'number') {
        window.clearTimeout(timerID);
      }
      pendingResyncTimeoutRef.current.delete(key);
    }
    clearResyncRequest(auth.user.id, selectedRoomID, senderUserID, messageID);
  }, [auth, selectedRoomID]);

  const queueDecryptRecoveryRequest = useCallback((
    messageID: number,
    senderUserID: number,
    senderDeviceID: string,
  ): 'sent' | 'invalid' | 'pending' | 'cooldown' | 'offline' | 'disconnected' => {
    if (!auth || !selectedRoomID) {
      return 'invalid';
    }
    if (
      !Number.isFinite(messageID)
      || messageID <= 0
      || !Number.isFinite(senderUserID)
      || senderUserID <= 0
    ) {
      return 'invalid';
    }

    const normalizedSenderDeviceID = senderDeviceID.trim();
    // Reject only same-user same-device which would loop back to ourselves.
    if (senderUserID === auth.user.id && (!normalizedSenderDeviceID || normalizedSenderDeviceID === auth.device.deviceId)) {
      return 'invalid';
    }
    // For other users, prefer sending only when we believe the target device is
    // reachable. Self-user cross-device requests are always allowed because the
    // server can route them to whichever device of ours is currently online.
    if (senderUserID !== auth.user.id && !hasOnlineSenderPeer(senderUserID, normalizedSenderDeviceID)) {
      return 'offline';
    }

    const requestKey = buildRecoveryRequestKey({
      roomId: selectedRoomID,
      fromUserId: auth.user.id,
      messageId: messageID,
      fromDeviceId: normalizedSenderDeviceID || undefined,
    });
    if (pendingResyncRecoveryRef.current.has(requestKey)) {
      return 'pending';
    }
    if (shouldCooldownResyncRequest(auth.user.id, selectedRoomID, senderUserID, messageID)) {
      return 'cooldown';
    }

    const request: DecryptRecoveryRequestFrame = {
      type: 'decrypt_recovery_request',
      roomId: selectedRoomID,
      toUserId: senderUserID,
      toDeviceId: normalizedSenderDeviceID || undefined,
      fromUserId: auth.user.id,
      fromUsername: auth.user.username,
      messageId: messageID,
      action: 'resync',
    };
    pendingResyncRecoveryRef.current.set(requestKey, request);
    const sent = sendJSON({
      type: 'decrypt_recovery_request',
      messageId: messageID,
      toDeviceId: normalizedSenderDeviceID || undefined,
      action: 'resync',
    });
    if (!sent) {
      pendingResyncRecoveryRef.current.delete(requestKey);
      return 'disconnected';
    }

    rememberResyncRequest(auth.user.id, selectedRoomID, senderUserID, messageID);
    const existingTimer = pendingResyncTimeoutRef.current.get(requestKey);
    if (typeof existingTimer === 'number') {
      window.clearTimeout(existingTimer);
    }
    const timeoutID = window.setTimeout(() => {
      pendingResyncRecoveryRef.current.delete(requestKey);
      pendingResyncTimeoutRef.current.delete(requestKey);
      clearResyncRequest(auth.user.id, selectedRoomID, senderUserID, messageID);
    }, RESYNC_REQUEST_TIMEOUT_MS);
    pendingResyncTimeoutRef.current.set(requestKey, timeoutID);
    return 'sent';
  }, [auth, selectedRoomID, sendJSON, hasOnlineSenderPeer]);

  const requestDecryptRecoveryIfNeeded = useCallback((message: Pick<ChatMessage, 'id' | 'senderId' | 'payload'>) => {
    const messageID = Number(message.id);
    const senderUserID = Number(message.senderId);
    const senderDeviceID = typeof message.payload?.senderDeviceId === 'string'
      ? message.payload.senderDeviceId.trim()
      : '';
    void queueDecryptRecoveryRequest(messageID, senderUserID, senderDeviceID);
  }, [queueDecryptRecoveryRequest]);

  const emitTypingStatus = useCallback((isTyping: boolean) => {
    if (!auth || !selectedRoomID || !wsConnected) {
      return;
    }
    if (sentTypingRef.current === isTyping) {
      return;
    }
    const sent = sendJSON({
      type: 'typing_status',
      isTyping,
    });
    if (sent) {
      sentTypingRef.current = isTyping;
    }
  }, [auth, selectedRoomID, wsConnected, sendJSON]);

  const commitReadReceipt = useCallback((upToMessageID: number): boolean => {
    if (!auth || !selectedRoomID || !wsConnected || upToMessageID <= 0) {
      return false;
    }
    if (upToMessageID <= lastReadMessageIDRef.current) {
      pendingReadReceiptRef.current = null;
      return false;
    }

    const sent = sendJSON({
      type: 'read_receipt',
      upToMessageId: upToMessageID,
    });
    if (!sent) {
      return false;
    }

    lastReadSentAtRef.current = Date.now();
    lastReadMessageIDRef.current = upToMessageID;
    pendingReadReceiptRef.current = null;
    setLocalReadCursor(selectedRoomID, upToMessageID);
    setLastReadMessageID((previous) => Math.max(previous, upToMessageID));
    setRoomMembers((previous) => previous.map((member) => {
      if (member.id !== auth.user.id) {
        return member;
      }
      return {
        ...member,
        lastReadMessageId: Math.max(member.lastReadMessageId ?? 0, upToMessageID),
      };
    }));
    setRooms((previous) => previous.map((room) => {
      if (room.id !== selectedRoomID || room.lastMessageId === null || room.lastMessageId > upToMessageID) {
        return room;
      }
      return {
        ...room,
        unreadCount: 0,
      };
    }));
    return true;
  }, [auth, selectedRoomID, wsConnected, sendJSON, setLocalReadCursor, setRoomMembers, setRooms]);

  const flushPendingReadReceipt = useCallback(() => {
    if (!auth || !selectedRoomID || !wsConnected) {
      return false;
    }
    const pending = pendingReadReceiptRef.current;
    if (!pending || pending <= 0) {
      return false;
    }

    const elapsed = Date.now() - lastReadSentAtRef.current;
    if (elapsed < READ_RECEIPT_THROTTLE_MS) {
      if (!readReceiptTimerRef.current) {
        readReceiptTimerRef.current = window.setTimeout(() => {
          readReceiptTimerRef.current = null;
          void flushPendingReadReceipt();
        }, READ_RECEIPT_THROTTLE_MS - elapsed);
      }
      return false;
    }

    if (readReceiptTimerRef.current) {
      window.clearTimeout(readReceiptTimerRef.current);
      readReceiptTimerRef.current = null;
    }

    return commitReadReceipt(pending);
  }, [auth, commitReadReceipt, selectedRoomID, wsConnected]);

  const emitReadReceipt = useCallback((upToMessageID: number) => {
    if (!auth || !selectedRoomID || upToMessageID <= 0) {
      return;
    }
    if (upToMessageID <= lastReadMessageIDRef.current) {
      return;
    }
    pendingReadReceiptRef.current = Math.max(pendingReadReceiptRef.current ?? 0, upToMessageID);
    void flushPendingReadReceipt();
  }, [auth, flushPendingReadReceipt, selectedRoomID]);

  useEffect(() => {
    if (!auth || !selectedRoomID) {
      return;
    }
    const normalizedLastReadMessageID = Math.max(0, Math.floor(lastReadMessageID));
    if (normalizedLastReadMessageID <= 0) {
      return;
    }
    setRooms((previous) => previous.map((room) => {
      if (room.id !== selectedRoomID) {
        return room;
      }
      return {
        ...room,
        unreadCount: 0,
      };
    }));
  }, [auth, lastReadMessageID, selectedRoomID, setRooms]);

  const notifyIncomingMessage = useCallback((message: UIMessage) => {
    if (!auth || message.senderId === auth.user.id || typeof Notification === 'undefined') {
      return;
    }
    if (notificationPermission !== 'granted' || !document.hidden) {
      return;
    }
    const room = rooms.find((candidate) => candidate.id === message.roomId);
    const roomLabel = room ? `#${room.id} ${room.name}` : `房间 #${message.roomId}`;
    const parsed = parseQuotedMessage(message.plaintext);
    const body = parsed.body.trim() || '[新消息]';
    const notification = new Notification(`${message.senderUsername} · ${roomLabel}`, {
      body: body.length > 72 ? `${body.slice(0, 72)}...` : body,
      tag: `room-${message.roomId}`,
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
    };
  }, [auth, notificationPermission, rooms]);

  const enqueueDecryptTask = useCallback(<T,>(task: () => Promise<T>): Promise<T> => {
    let resolveTask: (value: T | PromiseLike<T>) => void = () => {};
    let rejectTask: (reason?: unknown) => void = () => {};
    const result = new Promise<T>((resolve, reject) => {
      resolveTask = resolve;
      rejectTask = reject;
    });
    decryptQueueRef.current = decryptQueueRef.current
      .then(async () => {
        try {
          resolveTask(await task());
        } catch (reason: unknown) {
          rejectTask(reason);
        }
      })
      .catch(() => {
        // Keep queue flowing even if a task fails.
      });
    return result;
  }, []);

  const flushDecryptAckQueue = useCallback(async () => {
    if (!auth || !identity || !identityBound || !selectedRoomID) {
      return;
    }
    if (!wsConnected) {
      return;
    }
    if (pendingAckMessageIDsRef.current.size === 0) {
      return;
    }

    const pending = [...pendingAckMessageIDsRef.current];
    for (const messageID of pending) {
      try {
        const ackSignature = await signDecryptAck(
          selectedRoomID,
          messageID,
          auth.user.id,
          identity.signingPrivateKey,
        );
        const sent = sendJSON({
          type: 'decrypt_ack',
          roomId: selectedRoomID,
          messageId: messageID,
          senderSigningPublicKeyJwk: identity.signingPublicKeyJwk,
          ackSignature,
        });
        if (!sent) {
          break;
        }
        pendingAckMessageIDsRef.current.delete(messageID);
        ackedMessageIDsRef.current.add(messageID);
      } catch (reason: unknown) {
        reportError(reason, '发送解密回执失败');
        break;
      }
    }
  }, [auth, identity, identityBound, selectedRoomID, wsConnected, sendJSON, reportError]);

  const queueDecryptAck = useCallback((message: ChatMessage) => {
    if (!auth || message.senderId === auth.user.id || message.id <= 0) {
      return;
    }
    if (ackedMessageIDsRef.current.has(message.id) || pendingAckMessageIDsRef.current.has(message.id)) {
      return;
    }
    pendingAckMessageIDsRef.current.add(message.id);
    void flushDecryptAckQueue();
  }, [auth, flushDecryptAckQueue]);

  const decryptMessageView = useCallback(
    async (message: ChatMessage, cachedPlaintext?: string): Promise<UIMessage> => {
      const pendingWidthPx = estimatePendingWidth(message.payload?.ciphertext ?? '');
      if (message.revokedAt) {
        return {
          ...message,
          plaintext: '',
          decryptState: 'ok',
          pendingWidthPx,
        };
      }
      if (typeof cachedPlaintext === 'string') {
        return {
          ...message,
          plaintext: cachedPlaintext,
          decryptState: 'ok',
          pendingWidthPx,
        };
      }
      if (!auth || !identity || !identityBound) {
        return {
          ...message,
          plaintext: '本地安全身份正在初始化，请稍后再试。',
          decryptState: 'failed',
          pendingWidthPx,
        };
      }
      try {
        const senderDeviceID = typeof message.payload?.senderDeviceId === 'string' && message.payload.senderDeviceId.trim()
          ? message.payload.senderDeviceId.trim()
          : message.senderId === auth.user.id
            ? auth.device.deviceId
            : '';
        if (!senderDeviceID) {
          throw new Error('missing sender device id');
        }
        const { plaintext, rawContentKey } = await decryptPayloadWithContentKey(
          message.payload,
          auth.user.id,
          auth.device.deviceId,
          message.senderId,
          senderDeviceID,
          identity,
        );
        try {
          await persistDecryptedPlaintext(auth.user.id, message, plaintext, rawContentKey);
        } catch {
          // Ignore local plaintext cache write failure.
        }
        return {
          ...message,
          plaintext,
          decryptState: 'ok',
          pendingWidthPx,
        };
      } catch {
        if (
          auth.user.id === message.senderId &&
          typeof message.payload?.signature === 'string' &&
          message.payload.signature.trim()
        ) {
          const fallbackPlaintext = await readOutgoingPlaintext(
            auth.user.id,
            message.roomId,
            message.payload.signature,
          );
          if (fallbackPlaintext) {
            try {
              await persistDecryptedPlaintext(auth.user.id, message, fallbackPlaintext);
              await markOutgoingPlaintextDelivered(
                auth.user.id,
                message.roomId,
                message.payload.signature,
                message.id,
              );
            } catch {
              // Ignore local plaintext persistence failures.
            }
            return {
              ...message,
              plaintext: fallbackPlaintext,
              decryptState: 'ok',
              pendingWidthPx,
            };
          }
        }
        return {
          ...message,
          plaintext: '这条消息未对当前设备加密，暂时无法查看。',
          decryptState: 'failed',
          pendingWidthPx,
        };
      }
    },
    [auth, identity, identityBound],
  );

  const decryptMessagesSequentially = useCallback(
    async (
      sortedMessages: ChatMessage[],
      cachedPlaintexts: Map<number, string>,
    ): Promise<UIMessage[]> => {
      const next: UIMessage[] = [];
      for (const message of sortedMessages) {
        next.push(await enqueueDecryptTask(async () => decryptMessageView(message, cachedPlaintexts.get(message.id))));
      }
      return next;
    },
    [decryptMessageView, enqueueDecryptTask],
  );

  const decryptAndUpdate = useCallback(
    async (message: ChatMessage, options: { notify?: boolean } = {}) => {
      if (!message.roomId || activeRoomIDRef.current !== message.roomId) {
        return;
      }
      let cachedPlaintext: string | undefined;
      if (auth) {
        try {
          const cached = await loadCachedPlaintexts(auth.user.id, [message]);
          cachedPlaintext = cached.get(message.id);
        } catch {
          cachedPlaintext = undefined;
        }
      }

      const resolved = await decryptMessageView(message, cachedPlaintext);
      if (activeRoomIDRef.current !== resolved.roomId) {
        return;
      }
      setMessages((previous) => {
        const index = previous.findIndex((item) => item.id === resolved.id);
        if (index < 0) {
          return previous;
        }
        const current = previous[index];
        const unchanged =
          current.decryptState === resolved.decryptState &&
          current.plaintext === resolved.plaintext &&
          current.editedAt === resolved.editedAt &&
          current.revokedAt === resolved.revokedAt &&
          current.payload === resolved.payload;
        if (unchanged) {
          return previous;
        }
        const next = [...previous];
        next[index] = resolved;
        return next;
      });
      if (activeRoomIDRef.current !== resolved.roomId) {
        return;
      }
      if (resolved.decryptState === 'ok') {
        if (auth && resolved.senderId !== auth.user.id) {
          clearPendingRecoveryRequest(resolved.id, resolved.senderId);
        }
        queueDecryptAck(resolved);
        if (auth && resolved.senderId !== auth.user.id && stickToBottomRef.current) {
          emitReadReceipt(resolved.id);
        }
        if (options.notify) {
          notifyIncomingMessage(resolved);
        }
      } else if (auth) {
        // Allow recovery for both peer-sent messages and self-sent messages
        // that arrived from a different device of the same user. The
        // requestDecryptRecoveryIfNeeded helper checks that the sender device
        // is not this device before sending the request.
        const senderDeviceID = typeof resolved.payload?.senderDeviceId === 'string'
          ? resolved.payload.senderDeviceId.trim()
          : '';
        const isOwnSelfDeviceMessage = resolved.senderId === auth.user.id
          && (!senderDeviceID || senderDeviceID === auth.device.deviceId);
        if (!isOwnSelfDeviceMessage) {
          requestDecryptRecoveryIfNeeded(resolved);
        }
      }
    },
    [
      auth,
      decryptMessageView,
      queueDecryptAck,
      emitReadReceipt,
      notifyIncomingMessage,
      setMessages,
      clearPendingRecoveryRequest,
      requestDecryptRecoveryIfNeeded,
    ],
  );

  const upsertIncomingMessage = useCallback((message: ChatMessage) => {
    let inserted = false;
    setMessages((previous) => {
      const index = previous.findIndex((item) => item.id === message.id);
      const nextValue: UIMessage = {
        ...message,
        plaintext: 'Decrypting...',
        decryptState: 'pending',
        pendingWidthPx: estimatePendingWidth(message.payload?.ciphertext ?? ''),
      };
      if (index >= 0) {
        const clone = [...previous];
        clone[index] = { ...clone[index], ...nextValue };
        return clone;
      }
      inserted = true;
      return [...previous, nextValue].sort((a, b) => a.id - b.id);
    });
    if (message.payload.signature) {
      setLocalDraftMessages((previous) =>
        previous.filter((item) => item.localSignature !== message.payload.signature),
      );
    }
    if (inserted && !stickToBottomRef.current && auth && message.senderId !== auth.user.id) {
      setUnreadIncomingCount((previous) => previous + 1);
    }
  }, [auth, setLocalDraftMessages, setMessages]);

  const sendDecryptRecoveryPayload = useCallback(
    async (request: DecryptRecoveryRequestFrame): Promise<boolean> => {
      if (!auth || !identity || !identityBound) {
        return false;
      }
      if (request.fromUserId <= 0 || request.messageId <= 0) {
        return false;
      }
      const requestFromDeviceID = typeof request.fromDeviceId === 'string' ? request.fromDeviceId.trim() : '';
      // Reject only same-user same-device which would loop back to ourselves.
      if (request.fromUserId === auth.user.id && (!requestFromDeviceID || requestFromDeviceID === auth.device.deviceId)) {
        return false;
      }

      let original: ChatMessage | UIMessage | undefined = messagesRef.current.find(
        (item) =>
          item.id === request.messageId &&
          item.senderId === auth.user.id,
      );
      if (!original && selectedRoomID) {
        try {
          const response = await api.fetchMessages(selectedRoomID, {
            limit: 1,
            beforeMessageID: request.messageId + 1,
          });
          original = response.messages.find(
            (item) =>
              item.id === request.messageId &&
              item.senderId === auth.user.id,
          );
        } catch {
          // Ignore remote fetch failures and fallback to local caches.
        }
      }
      let recoveryPlaintext: string | undefined;
      if (
        original
        && 'decryptState' in original
        && original.decryptState === 'ok'
        && typeof original.plaintext === 'string'
        && original.plaintext
      ) {
        recoveryPlaintext = original.plaintext;
      }

      if (!recoveryPlaintext && original) {
        try {
          const cached = await loadCachedPlaintexts(auth.user.id, [original]);
          recoveryPlaintext = cached.get(request.messageId);
        } catch {
          // Ignore IDB read failures.
        }
      }
      if (
        !recoveryPlaintext
        && original
        && typeof original.payload?.signature === 'string'
        && original.payload.signature.trim()
      ) {
        recoveryPlaintext = await readOutgoingPlaintext(
          auth.user.id,
          original.roomId,
          original.payload.signature,
        ) ?? undefined;
      }
      if (!recoveryPlaintext) {
        setInfo(`收到 ${request.fromUsername} 的重同步请求，但本地明文不可用`);
        return false;
      }

      if (requestFromDeviceID) {
        await resetRatchetSession(
          auth.user.id,
          auth.device.deviceId,
          request.fromUserId,
          requestFromDeviceID,
        );
      }
      const recoveryRecipientUsers = [auth.user.id, request.fromUserId];
      const sessionStatus = await ensureRatchetSessionsForRecipients(
        auth.user.id,
        auth.device.deviceId,
        identity,
        recoveryRecipientUsers,
        resolveSignalBundle,
      );
      const pendingPeerIDs = sessionStatus.pendingUserIDs
        .filter((peerID) => peerID !== auth.user.id);
      if (pendingPeerIDs.length > 0) {
        throw new Error(`无法回传重同步消息，密钥会话未就绪: ${pendingPeerIDs.join(',')}`);
      }

      const recoveryRecipients = sessionStatus.readyRecipients.filter((recipient) => {
        // Always include ourselves (so the encrypted payload also lands on this
        // device's local cache and can be decrypted in case of replay).
        if (recipient.userID === auth.user.id && recipient.deviceID === auth.device.deviceId) {
          return true;
        }
        if (recipient.userID !== request.fromUserId) {
          return false;
        }
        // For the requesting peer (different user, or same user different
        // device), prefer the specific device, otherwise include all of them.
        if (!requestFromDeviceID) {
          return true;
        }
        return recipient.deviceID === requestFromDeviceID;
      });
      if (recoveryRecipients.length === 0) {
        throw new Error('无法回传重同步消息，目标设备会话未就绪');
      }

      const payload = await encryptForRecipients(
        recoveryPlaintext,
        auth.user.id,
        auth.device.deviceId,
        identity,
        recoveryRecipients,
      );
      const missingRecipients = recoveryRecipients
        .map((recipient) => buildRecipientAddress(recipient.userID, recipient.deviceID))
        .filter((address) => !(address in payload.wrappedKeys));
      if (missingRecipients.length > 0) {
        throw new Error(`回传重同步消息失败：密钥封装不完整 (${missingRecipients.join(',')})`);
      }

      const sent = sendJSON({
        type: 'decrypt_recovery_payload',
        messageId: request.messageId,
        toUserId: request.fromUserId,
        toDeviceId: requestFromDeviceID || undefined,
        ...payload,
      });
      if (!sent) {
        throw new Error('WebSocket 未连接');
      }

      setInfo(`已向 ${request.fromUsername} 回传消息 #${request.messageId}`);
      return true;
    },
    [api, auth, identity, identityBound, resolveSignalBundle, selectedRoomID, sendJSON, setInfo],
  );

  const sendEnvelopeRefill = useCallback(
    async (request: EnvelopeRefillRequestFrame): Promise<boolean> => {
      if (!auth || !identity || !identityBound || !selectedRoomID) {
        return false;
      }
      if (
        request.roomId !== selectedRoomID
        || request.toUserId !== auth.user.id
      ) {
        return false;
      }
      const targetDeviceID = typeof request.fromDeviceId === 'string' ? request.fromDeviceId.trim() : '';
      if (!targetDeviceID || targetDeviceID === auth.device.deviceId) {
        return false;
      }
      let requestedIDs = [...new Set(
        request.messageIds
          .map((messageID) => Math.floor(Number(messageID)))
          .filter((messageID) => Number.isFinite(messageID) && messageID > 0),
      )].slice(0, 200);
      if (requestedIDs.length === 0) {
        try {
          const refill = await api.requestDeviceEnvelopeRefill(targetDeviceID, selectedRoomID, []);
          requestedIDs = [...new Set(refill.messageIds
            .map((messageID) => Math.floor(Number(messageID)))
            .filter((messageID) => Number.isFinite(messageID) && messageID > 0))]
            .slice(0, 200);
        } catch {
          return false;
        }
      }
      if (requestedIDs.length === 0) {
        return false;
      }

      let originals = messagesRef.current.filter(
        (item) =>
          requestedIDs.includes(item.id)
          && item.roomId === selectedRoomID
          && item.senderId === auth.user.id,
      ) as ChatMessage[];
      const missingLocalIDs = requestedIDs.filter((messageID) => !originals.some((item) => item.id === messageID));
      if (missingLocalIDs.length > 0) {
        try {
          const fetched = await Promise.all(missingLocalIDs.map((messageID) =>
            api.fetchMessages(selectedRoomID, {
              limit: 1,
              beforeMessageID: messageID + 1,
            }),
          ));
          const fetchedMessages = fetched
            .flatMap((response) => response.messages)
            .filter(
              (message) =>
                requestedIDs.includes(message.id)
                && message.roomId === selectedRoomID
                && message.senderId === auth.user.id,
            );
          originals = [...originals, ...fetchedMessages];
        } catch {
          // Keep going with the messages and keys that are already local.
        }
      }

      const dedupedOriginals = [...new Map(originals.map((message) => [message.id, message])).values()];
      if (dedupedOriginals.length === 0) {
        return false;
      }

      const cachedKeys = await loadCachedContentKeys(auth.user.id, dedupedOriginals);
      for (const message of dedupedOriginals) {
        if (cachedKeys.has(message.id)) {
          continue;
        }
        const signature = typeof message.payload?.signature === 'string' ? message.payload.signature.trim() : '';
        if (!signature) {
          continue;
        }
        const outgoingKey = await loadOutgoingContentKey(auth.user.id, message.roomId, signature);
        if (outgoingKey) {
          cachedKeys.set(message.id, outgoingKey);
        }
      }
      if (cachedKeys.size === 0) {
        return false;
      }

      await ensureRatchetSessionsForRecipients(
        auth.user.id,
        auth.device.deviceId,
        identity,
        [auth.user.id],
        resolveSignalBundle,
      );
      const envelopes: Array<{ messageId: number; wrappedKey: ChatMessage['payload']['wrappedKeys'][string] }> = [];
      for (const message of dedupedOriginals) {
        const rawContentKey = cachedKeys.get(message.id);
        if (!rawContentKey) {
          continue;
        }
        const wrappedKey = await wrapContentKeyForRecipient(
          auth.user.id,
          auth.device.deviceId,
          identity,
          { userID: auth.user.id, deviceID: targetDeviceID },
          rawContentKey,
        );
        envelopes.push({ messageId: message.id, wrappedKey });
      }
      if (envelopes.length === 0) {
        return false;
      }
      await api.saveDeviceEnvelopeRefill(targetDeviceID, selectedRoomID, envelopes);
      setInfo(`已为设备 ${targetDeviceID} 补发 ${envelopes.length} 条历史消息信封`);
      return true;
    },
    [api, auth, identity, identityBound, resolveSignalBundle, selectedRoomID, setInfo],
  );

  useEffect(() => {
    if (onRoomSwitch) {
      onRoomSwitch();
    }
    setMessages([]);
    setIsRoomSwitching(Boolean(selectedRoomID));
    loadingMoreRef.current = false;
    preserveScrollRef.current = false;
    stickToBottomRef.current = true;
    lastScrolledMessageCountRef.current = 0;
    historyBeforeIDRef.current = null;
    lastReadMessageIDRef.current = 0;
    lastReadSentAtRef.current = 0;
    sentTypingRef.current = false;
    setTypingUsers({});
    setRoomSearchQuery('');
    setActiveSearchResultIndex(0);
    if (readReceiptTimerRef.current) {
      window.clearTimeout(readReceiptTimerRef.current);
      readReceiptTimerRef.current = null;
    }
    pendingReadReceiptRef.current = null;
    if (messageListRef.current) {
      messageListRef.current.scrollTop = 0;
    }
    setHistoryLoading(Boolean(selectedRoomID));
    setHasMoreHistory(false);
    setMessageReadReceipts({});
    setFocusMessageID(null);
    setUnreadIncomingCount(0);
    setFirstUnreadMessageID(null);
    setLastReadMessageID(0);
    ackedMessageIDsRef.current.clear();
    pendingAckMessageIDsRef.current.clear();
    pendingResyncRecoveryRef.current.clear();
    for (const timerID of pendingResyncTimeoutRef.current.values()) {
      window.clearTimeout(timerID);
    }
    pendingResyncTimeoutRef.current.clear();
    resyncSweepCursorRef.current = 0;
    for (const timerID of remoteTypingTimersRef.current.values()) {
      window.clearTimeout(timerID);
    }
    remoteTypingTimersRef.current.clear();
  }, [onRoomSwitch, selectedRoomID, setMessageReadReceipts, setMessages]);

  useEffect(() => {
    if (!auth || !selectedRoomID) {
      return;
    }
    const self = roomMembers.find((member) => member.id === auth.user.id);
    const lastReadMessageID = self?.lastReadMessageId;
    if (typeof lastReadMessageID !== 'number') {
      return;
    }
    const normalized = Math.max(0, Math.floor(lastReadMessageID));
    lastReadMessageIDRef.current = Math.max(lastReadMessageIDRef.current, normalized);
    setLocalReadCursor(selectedRoomID, normalized);
    setLastReadMessageID((previous) => Math.max(previous, normalized));
  }, [auth, selectedRoomID, roomMembers, setLocalReadCursor]);

  useEffect(() => {
    if (!auth || !selectedRoomID || !wsConnected || pendingReadReceiptRef.current === null) {
      return;
    }
    void flushPendingReadReceipt();
  }, [auth, flushPendingReadReceipt, selectedRoomID, wsConnected, handshakeTick]);

  useEffect(() => {
    if (!auth || !selectedRoomID || !wsConnected) {
      return;
    }
    const pending = pendingReadReceiptRef.current;
    if (pending === null || pending <= 0 || pending <= lastReadMessageIDRef.current) {
      return;
    }
    setRoomMembers((previous) => previous.map((member) => {
      if (member.id !== auth.user.id) {
        return member;
      }
      return {
        ...member,
        lastReadMessageId: Math.max(member.lastReadMessageId ?? 0, pending),
      };
    }));
  }, [auth, selectedRoomID, wsConnected, setRoomMembers]);

  useEffect(() => {
    if (!auth || messages.length === 0) {
      setFirstUnreadMessageID(null);
      return;
    }
    setFirstUnreadMessageID(
      findFirstUnreadIncomingMessageID(messages, auth.user.id, lastReadMessageID),
    );
  }, [auth, lastReadMessageID, messages]);

  useEffect(() => {
    if (!auth || !identity || !identityBound || !selectedRoomID) {
      setMessages([]);
      setIsRoomSwitching(false);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    setHistoryLoading(true);

    api
      .fetchMessages(
        selectedRoomID,
        { limit: MESSAGE_PAGE_SIZE },
        { signal: controller.signal },
      )
      .then(async ({ messages: serverMessages, hasMore }) => {
        if (cancelled) {
          return;
        }

        const sorted = [...serverMessages].sort((a, b) => a.id - b.id);
        let cachedPlaintexts = new Map<number, string>();
        try {
          cachedPlaintexts = await loadCachedPlaintexts(auth.user.id, sorted);
        } catch {
          cachedPlaintexts = new Map<number, string>();
        }
        const decrypted = await decryptMessagesSequentially(sorted, cachedPlaintexts);
        if (cancelled) {
          return;
        }

        const nextHasMore = typeof hasMore === 'boolean'
          ? hasMore
          : serverMessages.length >= MESSAGE_PAGE_SIZE;
        setHasMoreHistory(nextHasMore);
        historyBeforeIDRef.current = decrypted[0]?.id ?? null;
        stickToBottomRef.current = true;

        setMessages((previous) => mergeMessagesByID(previous, decrypted));
        for (const item of decrypted) {
          if (item.decryptState === 'ok') {
            queueDecryptAck(item);
          }
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          reportError(reason, '加载历史消息失败');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setHistoryLoading(false);
          window.requestAnimationFrame(() => {
            setIsRoomSwitching(false);
          });
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [api, auth, identity, identityBound, selectedRoomID, decryptMessagesSequentially, queueDecryptAck, reportError, setMessages]);

  useEffect(() => {
    if (!auth || !identity || !identityBound || !selectedRoomID) {
      disconnect('switch room');
      setPeers({});
      return;
    }
    connect({
      roomID: selectedRoomID,
    });
    return () => {
      disconnect('switch room');
    };
  }, [auth, identity, identityBound, selectedRoomID, connect, disconnect, setPeers]);

  useEffect(() => {
    if (!wsConnected || !auth || !identity || !identityBound || !selectedRoomID) {
      return;
    }
    setError('');
    sendJSON({
      type: 'key_announce',
      publicKeyJwk: identity.publicKeyJwk,
      signingPublicKeyJwk: identity.signingPublicKeyJwk,
    });
    bumpHandshakeTick();
    void flushDecryptAckQueue();
  }, [
    wsConnected,
    auth,
    identity,
    identityBound,
    selectedRoomID,
    sendJSON,
    bumpHandshakeTick,
    flushDecryptAckQueue,
    setError,
  ]);

  useEffect(() => {
    if (!auth || !identity || !identityBound || !selectedRoomID) {
      return;
    }

    const unsubscribe = subscribeMessage((frame) => {
      if (frame.type === 'room_peers') {
        const nextPeers: Record<string, Peer> = {};
        const values = Array.isArray(frame.peers) ? frame.peers : [];
        for (const candidate of values) {
          const peer = candidate as Peer;
          const peerDeviceID = typeof peer?.deviceId === 'string' ? peer.deviceId.trim() : '';
          if (peer?.userId && peerDeviceID && peer?.publicKeyJwk && peer?.signingPublicKeyJwk) {
            nextPeers[buildRecipientAddress(peer.userId, peerDeviceID)] = {
              ...peer,
              deviceId: peerDeviceID,
            };
          }
        }
        setPeers(nextPeers);
        return;
      }

      if (frame.type === 'peer_key') {
        const peerDeviceID = typeof frame.deviceId === 'string' ? frame.deviceId.trim() : '';
        const peer = {
          userId: Number(frame.userId),
          username: String(frame.username ?? ''),
          deviceId: peerDeviceID,
          deviceName: typeof frame.deviceName === 'string' ? frame.deviceName : undefined,
          publicKeyJwk: frame.publicKeyJwk as JsonWebKey,
          signingPublicKeyJwk: frame.signingPublicKeyJwk as JsonWebKey,
        };
        if (!peer.userId || !peer.deviceId || !peer.publicKeyJwk || !peer.signingPublicKeyJwk) {
          return;
        }
        setPeers((previous) => ({ ...previous, [buildRecipientAddress(peer.userId, peer.deviceId)]: peer }));
        // Proactively establish ratchet session with new peer. This also covers
        // the multi-device case where one of our own devices joins the room
        // (peer.userId === auth.user.id but peer.deviceId !== local device id) —
        // we still need to fetch the new peer's prekey bundle and create a
        // session so future messages reach them.
        const isAnotherOwnDevice = peer.userId === auth.user.id && peer.deviceId !== auth.device.deviceId;
        if (peer.userId !== auth.user.id || isAnotherOwnDevice) {
          void ensureRatchetSessionsForRecipients(
            auth.user.id,
            auth.device.deviceId,
            identity,
            [auth.user.id, peer.userId],
            resolveSignalBundle,
          ).then(() => {
            bumpHandshakeTick();
          }).catch(() => {
            // Session establishment may fail for new peers; not critical
          });
        }
        return;
      }

      if (frame.type === 'peer_left') {
        const peerID = Number(frame.userId);
        const peerDeviceID = typeof frame.deviceId === 'string' ? frame.deviceId.trim() : '';
        if (!peerID) {
          return;
        }
        setPeers((previous) => {
          const next = { ...previous };
          if (peerDeviceID) {
            delete next[buildRecipientAddress(peerID, peerDeviceID)];
            return next;
          }
          for (const [key, value] of Object.entries(next)) {
            if (value.userId === peerID) {
              delete next[key];
            }
          }
          return next;
        });
        return;
      }

      if (frame.type === 'user_bundle_changed') {
        const bundleChange = frame as unknown as UserBundleChangedFrame;
        const targetUserID = Number(bundleChange.userId);
        if (!Number.isFinite(targetUserID) || targetUserID <= 0) {
          return;
        }
        // Refresh ratchet sessions for the user whose bundle just changed so we
        // pick up newly registered devices (e.g. a user just logged in on a
        // second device and uploaded a fresh prekey bundle). The handshake
        // tick bump retriggers any pending send-queue items so they encrypt
        // for the new device too.
        const isOwnUser = targetUserID === auth.user.id;
        if (isOwnUser && bundleChange.deviceId === auth.device.deviceId) {
          // Our own publish — ignore the echo.
          return;
        }
        void ensureRatchetSessionsForRecipients(
          auth.user.id,
          auth.device.deviceId,
          identity,
          [auth.user.id, targetUserID],
          resolveSignalBundle,
        ).then(() => {
          bumpHandshakeTick();
        }).catch(() => {
          // Best-effort; the next message send will retry session setup.
        });
        return;
      }

      if (frame.type === 'ciphertext') {
        const message = frame as unknown as ChatMessage;
        if (message.roomId !== selectedRoomID) {
          return;
        }
        upsertIncomingMessage(message);
        void enqueueDecryptTask(async () => {
          await decryptAndUpdate(message, { notify: true });
        });
        return;
      }

      if (frame.type === 'decrypt_ack') {
        return;
      }

      if (frame.type === 'typing_status') {
        const typing = frame as unknown as TypingStatusFrame;
        if (typing.roomId !== selectedRoomID || typing.fromUserId === auth.user.id || typing.fromUserId <= 0) {
          return;
        }
        const existingTimer = remoteTypingTimersRef.current.get(typing.fromUserId);
        if (typeof existingTimer === 'number') {
          window.clearTimeout(existingTimer);
          remoteTypingTimersRef.current.delete(typing.fromUserId);
        }
        if (!typing.isTyping) {
          setTypingUsers((previous) => {
            if (!(typing.fromUserId in previous)) {
              return previous;
            }
            const next = { ...previous };
            delete next[typing.fromUserId];
            return next;
          });
          return;
        }
        setTypingUsers((previous) => ({
          ...previous,
          [typing.fromUserId]: typing.fromUsername,
        }));
        const timeoutID = window.setTimeout(() => {
          remoteTypingTimersRef.current.delete(typing.fromUserId);
          setTypingUsers((previous) => {
            if (!(typing.fromUserId in previous)) {
              return previous;
            }
            const next = { ...previous };
            delete next[typing.fromUserId];
            return next;
          });
        }, TYPING_IDLE_MS * 2);
        remoteTypingTimersRef.current.set(typing.fromUserId, timeoutID);
        return;
      }

      if (frame.type === 'read_receipt') {
        const receipt = frame as unknown as ReadReceiptFrame;
        if (receipt.roomId !== selectedRoomID) {
          return;
        }
        registerReadReceiptUpTo(Number(receipt.fromUserId), Number(receipt.upToMessageId));
        return;
      }

      if (frame.type === 'protocol_error') {
        const protocolError = frame as unknown as ProtocolErrorFrame;
        if (protocolError.roomId !== selectedRoomID) {
          return;
        }
        if (protocolError.code === 'legacy_payload_not_supported') {
          setError('检测到旧协议密文，已停止自动恢复。请刷新页面并让发送方重新发送该消息。');
          return;
        }
        if (protocolError.code === 'invalid_payload_format') {
          setError('消息密文格式异常。可先请求重同步；若仍失败，请重新登录后重试。');
          return;
        }
        if (protocolError.code === 'ciphertext_rate_limited') {
          setError('发送过快，请稍后再试。');
          return;
        }
        if (protocolError.code === 'websocket_auth_expired') {
          setError('登录状态已失效，请重新登录。');
          return;
        }
        const detail = typeof protocolError.message === 'string' && protocolError.message.trim()
          ? protocolError.message.trim()
          : '检测到协议不兼容，请刷新页面后重试。';
        setError(detail);
        return;
      }

      if (frame.type === 'message_update') {
        const update = frame as unknown as MessageUpdateFrame;
        if (update.roomId !== selectedRoomID || update.messageId <= 0) {
          return;
        }
        const existing = messagesRef.current.find((item) => item.id === update.messageId);
        if (!existing || existing.senderId !== update.fromUserId) {
          return;
        }
        if (update.mode === 'revoke') {
          const revokedMessage: ChatMessage = {
            ...existing,
            editedAt: null,
            revokedAt: update.revokedAt ?? new Date().toISOString(),
          };
          upsertIncomingMessage(revokedMessage);
          void enqueueDecryptTask(async () => {
            await decryptAndUpdate(revokedMessage);
          });
          return;
        }
        if (update.mode === 'edit' && update.payload) {
          const editedMessage: ChatMessage = {
            ...existing,
            payload: update.payload,
            editedAt: update.editedAt ?? new Date().toISOString(),
            revokedAt: null,
          };
          upsertIncomingMessage(editedMessage);
          void enqueueDecryptTask(async () => {
            await decryptAndUpdate(editedMessage);
          });
        }
        return;
      }

      if (frame.type === 'decrypt_recovery_payload') {
        const recovery = frame as unknown as DecryptRecoveryPayloadFrame;
        if (recovery.roomId !== selectedRoomID || recovery.toUserId !== auth.user.id) {
          return;
        }
        const recoveryToDeviceID = typeof recovery.toDeviceId === 'string' ? recovery.toDeviceId.trim() : '';
        if (recoveryToDeviceID && recoveryToDeviceID !== auth.device.deviceId) {
          return;
        }
        if (recovery.messageId <= 0 || recovery.fromUserId <= 0 || !recovery.payload) {
          return;
        }
        clearPendingRecoveryRequest(recovery.messageId, recovery.fromUserId);
        const existing = messagesRef.current.find((item) => item.id === recovery.messageId);
        if (!existing || existing.senderId !== recovery.fromUserId) {
          return;
        }
        const repairedMessage: ChatMessage = {
          id: existing.id,
          roomId: existing.roomId,
          senderId: existing.senderId,
          senderUsername: existing.senderUsername || recovery.fromUsername,
          createdAt: existing.createdAt,
          editedAt: existing.editedAt,
          revokedAt: existing.revokedAt,
          payload: recovery.payload,
        };
        upsertIncomingMessage(repairedMessage);
        // Let decryptPayload's existing prekey-bootstrap fallback handle the
        // session establishment. Eagerly resetting can cause oscillation when
        // the peer issues redundant recovery payloads.
        void enqueueDecryptTask(async () => {
          await decryptAndUpdate(repairedMessage);
        });
        setInfo(`已收到消息 #${recovery.messageId} 的解密恢复数据`);
        return;
      }

      if (frame.type === 'envelope_refill_request') {
        const request = frame as unknown as EnvelopeRefillRequestFrame;
        if (request.roomId !== selectedRoomID || request.toUserId !== auth.user.id) {
          return;
        }
        const requestToDeviceID = typeof request.toDeviceId === 'string' ? request.toDeviceId.trim() : '';
        if (requestToDeviceID && requestToDeviceID !== auth.device.deviceId) {
          return;
        }
        void sendEnvelopeRefill(request).catch((reason: unknown) => {
          reportError(reason, '补发设备信封失败');
        });
        return;
      }

      if (frame.type === 'decrypt_recovery_request') {
        const request = frame as unknown as DecryptRecoveryRequestFrame;
        if (request.roomId !== selectedRoomID || request.toUserId !== auth.user.id) {
          return;
        }
        const requestToDeviceID = typeof request.toDeviceId === 'string' ? request.toDeviceId.trim() : '';
        if (requestToDeviceID && requestToDeviceID !== auth.device.deviceId) {
          return;
        }
        if (request.fromUserId <= 0 || request.messageId <= 0) {
          return;
        }
        const requestFromDeviceID = typeof request.fromDeviceId === 'string' ? request.fromDeviceId.trim() : '';
        // Reject same-user same-device which would loop back to ourselves.
        if (request.fromUserId === auth.user.id && (!requestFromDeviceID || requestFromDeviceID === auth.device.deviceId)) {
          return;
        }

        const requestKey = buildRecoveryRequestKey(request);
        if (pendingResyncRecoveryRef.current.has(requestKey)) {
          return;
        }
        const action = request.action ?? 'resync';
        if (action === 'resync') {
          pendingResyncRecoveryRef.current.set(requestKey, request);
          void ensureRatchetSessionsForRecipients(
            auth.user.id,
            auth.device.deviceId,
            identity,
            [auth.user.id, request.fromUserId],
            resolveSignalBundle,
          ).then(() => {
            bumpHandshakeTick();
            setInfo(`已向 ${request.fromUsername} 发起密钥重同步`);
            void sendDecryptRecoveryPayload(request)
              .then((sent) => {
                if (sent) {
                  pendingResyncRecoveryRef.current.delete(requestKey);
                }
              })
              .catch((reason: unknown) => {
                reportError(reason, '处理密钥重同步请求失败');
              });
          }).catch((reason: unknown) => {
            pendingResyncRecoveryRef.current.delete(requestKey);
            reportError(reason, '处理密钥重同步请求失败');
          });
        }
      }

    });
    return unsubscribe;
  }, [
    auth,
    identity,
    identityBound,
    selectedRoomID,
    subscribeMessage,
    decryptAndUpdate,
    enqueueDecryptTask,
    upsertIncomingMessage,
    resolveSignalBundle,
    sendDecryptRecoveryPayload,
    sendEnvelopeRefill,
    registerReadReceiptUpTo,
    reportError,
    bumpHandshakeTick,
    setPeers,
    sendJSON,
    setError,
    setInfo,
    clearPendingRecoveryRequest,
  ]);

  useEffect(() => {
    if (!auth || !identity || !identityBound || !selectedRoomID) {
      return;
    }
    const unsubscribeOpen = subscribeOpen(() => {
      const requestedRoomID = selectedRoomID;
      api.listRoomMembers(selectedRoomID)
        .then(({ members }) => {
          if (activeRoomIDRef.current !== requestedRoomID) {
            return;
          }
          setRoomMembers(members);
        })
        .catch((reason: unknown) => {
          reportError(reason, '重连同步成员已读状态失败');
        });

      const latestKnownID = findLatestServerMessageID(messagesRef.current);
      fetchMissingMessagesAfterCursor(
        (afterMessageID) => api.fetchMessages(selectedRoomID, {
          limit: MESSAGE_PAGE_SIZE,
          ...(afterMessageID ? { afterMessageID } : {}),
        }),
        latestKnownID,
        MESSAGE_PAGE_SIZE,
      )
        .then(async (serverMessages) => {
          if (activeRoomIDRef.current !== requestedRoomID) {
            return;
          }
          if (serverMessages.length === 0) {
            return;
          }
          let cachedPlaintexts = new Map<number, string>();
          try {
            cachedPlaintexts = await loadCachedPlaintexts(auth.user.id, serverMessages);
          } catch {
            cachedPlaintexts = new Map<number, string>();
          }
          const decrypted = await decryptMessagesSequentially(serverMessages, cachedPlaintexts);
          if (activeRoomIDRef.current !== requestedRoomID) {
            return;
          }

          setMessages((previous) => mergeMessagesByID(previous, decrypted));

          for (const item of decrypted) {
            if (item.decryptState === 'ok') {
              queueDecryptAck(item);
            }
          }
        })
        .catch((reason: unknown) => {
          reportError(reason, '重连同步消息失败');
        });
    });
    return unsubscribeOpen;
  }, [auth, identity, identityBound, selectedRoomID, subscribeOpen, api, decryptMessagesSequentially, setMessages, queueDecryptAck, reportError, setRoomMembers]);

  useEffect(() => {
    if (!wsConnected) {
      return;
    }
    void flushDecryptAckQueue();
  }, [wsConnected, handshakeTick, flushDecryptAckQueue]);

  const runResyncSweep = useCallback(() => {
    if (!auth || !identity || !identityBound || !selectedRoomID) {
      return;
    }
    const failedMessages = messagesRef.current.filter(
      (message) =>
        message.roomId === selectedRoomID &&
        message.decryptState === 'failed',
    );
    if (failedMessages.length === 0) {
      resyncSweepCursorRef.current = 0;
      return;
    }

    const batchSize = Math.min(RESYNC_SWEEP_BATCH_SIZE, failedMessages.length);
    const startIndex = resyncSweepCursorRef.current % failedMessages.length;
    for (let offset = 0; offset < batchSize; offset += 1) {
      const index = (startIndex + offset) % failedMessages.length;
      const message = failedMessages[index];
      const hasWrappedKey = message.payload?.wrappedKeys?.[
        buildRecipientAddress(auth.user.id, auth.device.deviceId)
      ];
      if (hasWrappedKey) {
        void enqueueDecryptTask(async () => {
          await decryptAndUpdate(message);
        });
      }
      const messageSenderDeviceID = typeof message.payload?.senderDeviceId === 'string'
        ? message.payload.senderDeviceId.trim()
        : '';
      const isOwnSelfDeviceMessage = message.senderId === auth.user.id
        && (!messageSenderDeviceID || messageSenderDeviceID === auth.device.deviceId);
      if (!isOwnSelfDeviceMessage) {
        requestDecryptRecoveryIfNeeded(message);
      }
    }
    resyncSweepCursorRef.current = (startIndex + batchSize) % failedMessages.length;
  }, [
    auth,
    identity,
    identityBound,
    selectedRoomID,
    enqueueDecryptTask,
    decryptAndUpdate,
    requestDecryptRecoveryIfNeeded,
  ]);

  useEffect(() => {
    if (!auth || !identity || !identityBound || !selectedRoomID) {
      return;
    }
    runResyncSweep();
    const timerID = window.setInterval(() => {
      runResyncSweep();
    }, RESYNC_SWEEP_INTERVAL_MS);
    return () => {
      window.clearInterval(timerID);
    };
  }, [auth, identity, identityBound, selectedRoomID, handshakeTick, runResyncSweep]);

  useLayoutEffect(() => {
    const list = messageListRef.current;

    if (preserveScrollRef.current && scrollRestoreRef.current && list) {
      const { scrollTop, scrollHeight } = scrollRestoreRef.current;
      list.scrollTop = list.scrollHeight - scrollHeight + scrollTop;
      scrollRestoreRef.current = null;
      preserveScrollRef.current = false;
      return;
    }

    if (loadingMoreRef.current) {
      return;
    }
    if (!stickToBottomRef.current) {
      lastScrolledMessageCountRef.current = messages.length;
      return;
    }
    if (!list) {
      return;
    }
    if (isRoomSwitching && messages.length === 0) {
      return;
    }
    const prevCount = lastScrolledMessageCountRef.current;
    lastScrolledMessageCountRef.current = messages.length;
    let latestReadableIncomingMessageID = 0;
    if (auth) {
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.senderId === auth.user.id || message.decryptState !== 'ok') {
          continue;
        }
        latestReadableIncomingMessageID = message.id;
        break;
      }
    }
    if (messages.length > 0 && messages.length === prevCount) {
      if (latestReadableIncomingMessageID > lastReadMessageIDRef.current) {
        emitReadReceipt(latestReadableIncomingMessageID);
      }
      return;
    }
    setUnreadIncomingCount(0);
    list.scrollTop = list.scrollHeight;
    if (latestReadableIncomingMessageID > 0) {
      emitReadReceipt(latestReadableIncomingMessageID);
    }
  }, [auth, emitReadReceipt, isRoomSwitching, messages]);

  const getLatestReadableIncomingMessageID = useCallback((): number => {
    if (!auth) {
      return 0;
    }
    for (let index = messagesRef.current.length - 1; index >= 0; index -= 1) {
      const message = messagesRef.current[index];
      if (message.senderId === auth.user.id) {
        continue;
      }
      if (message.decryptState !== 'ok') {
        continue;
      }
      return message.id;
    }
    return 0;
  }, [auth]);

  const handleLoadMoreHistory = useCallback(() => {
    if (!auth || !identity || !identityBound || !selectedRoomID || !hasMoreHistory || historyLoading || loadingMoreRef.current) {
      return;
    }
    const beforeMessageID = historyBeforeIDRef.current ?? messagesRef.current[0]?.id ?? null;
    if (!beforeMessageID || beforeMessageID <= 0) {
      return;
    }
    const list = messageListRef.current;
    const previousScrollTop = list?.scrollTop ?? 0;
    const previousScrollHeight = list?.scrollHeight ?? 0;
    loadingMoreRef.current = true;
    preserveScrollRef.current = true;
    scrollRestoreRef.current = { scrollTop: previousScrollTop, scrollHeight: previousScrollHeight };
    setHistoryLoading(true);

    api.fetchMessages(selectedRoomID, {
      limit: MESSAGE_PAGE_SIZE,
      beforeMessageID,
    }).then(async ({ messages: serverMessages, hasMore }) => {
      const sorted = [...serverMessages].sort((a, b) => a.id - b.id);
      let cachedPlaintexts = new Map<number, string>();
      try {
        cachedPlaintexts = await loadCachedPlaintexts(auth.user.id, sorted);
      } catch {
        cachedPlaintexts = new Map<number, string>();
      }
      const decrypted = await decryptMessagesSequentially(sorted, cachedPlaintexts);

      setMessages((previous) => {
        if (decrypted.length === 0) {
          return previous;
        }
        const existingIDs = new Set(previous.map((item) => item.id));
        const deduped = decrypted.filter((item) => !existingIDs.has(item.id));
        if (deduped.length === 0) {
          return previous;
        }
        return [...deduped, ...previous].sort((a, b) => a.id - b.id);
      });

      historyBeforeIDRef.current = decrypted[0]?.id ?? historyBeforeIDRef.current;
      const nextHasMore = typeof hasMore === 'boolean'
        ? hasMore
        : serverMessages.length >= MESSAGE_PAGE_SIZE;
      setHasMoreHistory(nextHasMore);
      window.requestAnimationFrame(() => {
        loadingMoreRef.current = false;
        setHistoryLoading(false);
      });
    }).catch((reason: unknown) => {
      reportError(reason, '加载更早历史消息失败');
      preserveScrollRef.current = false;
      loadingMoreRef.current = false;
      setHistoryLoading(false);
    });
  }, [api, auth, identity, identityBound, selectedRoomID, hasMoreHistory, historyLoading, decryptMessagesSequentially, reportError, setMessages]);

  const handleMessageListScroll = useCallback(() => {
    const list = messageListRef.current;
    if (!list) {
      return;
    }
    const distance = list.scrollHeight - list.scrollTop - list.clientHeight;
    const isAtBottom = distance < 120;
    stickToBottomRef.current = isAtBottom;
    if (isAtBottom) {
      setUnreadIncomingCount(0);
      const latestIncomingID = getLatestReadableIncomingMessageID();
      if (latestIncomingID > 0) {
        emitReadReceipt(latestIncomingID);
      }
    }
  }, [emitReadReceipt, getLatestReadableIncomingMessageID]);

  const handleJumpToLatest = useCallback(() => {
    stickToBottomRef.current = true;
    setUnreadIncomingCount(0);
    const list = messageListRef.current;
    if (!list) {
      return;
    }
    list.scrollTop = list.scrollHeight;
    const latestIncomingID = getLatestReadableIncomingMessageID();
    if (latestIncomingID > 0) {
      emitReadReceipt(latestIncomingID);
    }
  }, [emitReadReceipt, getLatestReadableIncomingMessageID]);

  const handleFocusMessageHandled = useCallback((found: boolean) => {
    setFocusMessageID(null);
    if (!found) {
      setInfo('引用消息不在当前历史窗口，可先加载更早消息');
    }
  }, [setInfo]);

  const roomSearchMatches = useMemo(() => {
    const query = roomSearchQuery.trim().toLowerCase();
    if (!query) {
      return [] as number[];
    }
    return messages
      .filter((message) => message.decryptState === 'ok')
      .filter((message) => !message.revokedAt)
      .filter((message) => {
        const senderMatched = message.senderUsername.toLowerCase().includes(query);
        if (senderMatched) {
          return true;
        }
        return parseQuotedMessage(message.plaintext).body.toLowerCase().includes(query);
      })
      .map((message) => message.id);
  }, [messages, roomSearchQuery]);

  useEffect(() => {
    if (!roomSearchQuery.trim()) {
      setActiveSearchResultIndex(0);
      return;
    }
    setActiveSearchResultIndex((previous) =>
      Math.min(previous, Math.max(0, roomSearchMatches.length - 1)),
    );
  }, [roomSearchMatches.length, roomSearchQuery]);

  useEffect(() => {
    if (!roomSearchQuery.trim() || roomSearchMatches.length === 0) {
      return;
    }
    const targetMessageID = roomSearchMatches[activeSearchResultIndex];
    if (typeof targetMessageID === 'number' && targetMessageID > 0) {
      setFocusMessageID(targetMessageID);
    }
  }, [activeSearchResultIndex, roomSearchMatches, roomSearchQuery]);

  useEffect(() => {
    const list = messageListRef.current;
    let isAtBottom = stickToBottomRef.current;
    if (list) {
      const distance = list.scrollHeight - list.scrollTop - list.clientHeight;
      if (distance < 120) {
        isAtBottom = true;
        stickToBottomRef.current = true;
      }
    }
    if (!isAtBottom) {
      return;
    }
    const latestIncomingID = getLatestReadableIncomingMessageID();
    if (latestIncomingID > 0) {
      emitReadReceipt(latestIncomingID);
    }
  }, [messages, emitReadReceipt, getLatestReadableIncomingMessageID]);

  useEffect(() => {
    const onFocus = () => {
      const list = messageListRef.current;
      if (list) {
        const distance = list.scrollHeight - list.scrollTop - list.clientHeight;
        if (distance < 120) {
          const latestIncomingID = getLatestReadableIncomingMessageID();
          if (latestIncomingID > 0) {
            emitReadReceipt(latestIncomingID);
          }
        }
      }
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [emitReadReceipt, getLatestReadableIncomingMessageID]);

  useEffect(() => {
    if (wsConnected || !sentTypingRef.current) {
      return;
    }
    sentTypingRef.current = false;
  }, [wsConnected]);

  const handleSearchPrev = useCallback(() => {
    if (roomSearchMatches.length === 0) {
      return;
    }
    setActiveSearchResultIndex((previous) =>
      (previous - 1 + roomSearchMatches.length) % roomSearchMatches.length,
    );
  }, [roomSearchMatches.length]);

  const handleSearchNext = useCallback(() => {
    if (roomSearchMatches.length === 0) {
      return;
    }
    setActiveSearchResultIndex((previous) => (previous + 1) % roomSearchMatches.length);
  }, [roomSearchMatches.length]);

  const handleEditMessage = useCallback(async (message: UIMessage) => {
    if (!auth || !identity || !identityBound || !selectedRoomID || message.senderId !== auth.user.id || message.revokedAt) {
      return;
    }
    const edited = window.prompt('编辑消息', message.plaintext);
    if (edited === null) {
      return;
    }
    const nextText = edited.trim();
    if (!nextText) {
      setError('消息内容不能为空');
      return;
    }
    if (nextText === message.plaintext.trim()) {
      return;
    }

    const recipientIDs = [...new Set(
      roomMembers
        .map((member) => member.id)
        .filter((memberID) => Number.isFinite(memberID) && memberID > 0),
    )];
    if (!recipientIDs.includes(auth.user.id)) {
      recipientIDs.unshift(auth.user.id);
    }

    try {
      const sessionStatus = await ensureRatchetSessionsForRecipients(
        auth.user.id,
        auth.device.deviceId,
        identity,
        recipientIDs,
        resolveSignalBundle,
      );
      const pendingPeerIDs = sessionStatus.pendingUserIDs;
      if (pendingPeerIDs.length > 0) {
        const deduped = [...new Set(pendingPeerIDs)].sort((left, right) => left - right);
        throw new Error(`编辑已中止：以下成员密钥会话未就绪 (${deduped.join(',')})`);
      }
      const payload = await encryptForRecipients(
        nextText,
        auth.user.id,
        auth.device.deviceId,
        identity,
        sessionStatus.readyRecipients,
      );
      const missingRecipients = sessionStatus.readyRecipients
        .map((recipient) => buildRecipientAddress(recipient.userID, recipient.deviceID))
        .filter((address) => !(address in payload.wrappedKeys));
      if (missingRecipients.length > 0) {
        throw new Error(`编辑已中止：密钥封装不完整 (${missingRecipients.join(',')})`);
      }
      const sent = sendJSON({
        type: 'message_update',
        mode: 'edit',
        messageId: message.id,
        ...payload,
      });
      if (!sent) {
        throw new Error('WebSocket 未连接');
      }
      setInfo(`已发送消息 #${message.id} 的编辑更新`);
    } catch (reason: unknown) {
      reportError(reason, '编辑消息失败');
    }
  }, [auth, identity, identityBound, selectedRoomID, roomMembers, resolveSignalBundle, sendJSON, reportError, setError, setInfo]);

  const handleRevokeMessage = useCallback((messageID: number) => {
    if (!auth || !selectedRoomID || messageID <= 0) {
      return;
    }
    const confirmed = window.confirm(`确认撤回消息 #${messageID}？`);
    if (!confirmed) {
      return;
    }
    const sent = sendJSON({
      type: 'message_update',
      mode: 'revoke',
      messageId: messageID,
    });
    if (!sent) {
      setError('当前处于离线状态，无法撤回消息');
      return;
    }
    setInfo(`已请求撤回消息 #${messageID}`);
  }, [auth, selectedRoomID, sendJSON, setError, setInfo]);

  const handleRequestDecryptRecovery = useCallback((
    messageID: number,
    senderUserID: number,
  ) => {
    if (!auth || !selectedRoomID) {
      return;
    }
    const targetMessage = messagesRef.current.find((item) => item.id === messageID);
    const targetDeviceID = typeof targetMessage?.payload?.senderDeviceId === 'string'
      ? targetMessage.payload.senderDeviceId.trim()
      : '';
    const status = queueDecryptRecoveryRequest(messageID, senderUserID, targetDeviceID);
    if (status === 'sent') {
      setInfo(`已请求发送方重同步密钥（消息 #${messageID}）`);
      return;
    }
    if (status === 'cooldown') {
      setInfo(`消息 #${messageID} 已在冷却期内请求过重同步`);
      return;
    }
    if (status === 'pending') {
      setInfo(`消息 #${messageID} 的重同步请求正在处理中`);
      return;
    }
    if (status === 'offline') {
      setInfo(`发送方当前不在线，消息 #${messageID} 将在其上线后自动重试`);
      return;
    }
    setError('当前处于离线状态，无法发送恢复请求');
  }, [auth, selectedRoomID, queueDecryptRecoveryRequest, setError, setInfo]);

  const resetReplyAndFocusState = useCallback(() => {
    setFocusMessageID(null);
  }, []);

  const timelineItems = useTimelineItems(messages, toLocalDateParts, formatTimelineLabel, firstUnreadMessageID);

  const typingIndicatorText = useMemo(() => {
    const usernames = Object.values(typingUsers).filter(Boolean);
    if (usernames.length === 0) {
      return '';
    }
    if (usernames.length === 1) {
      return `${usernames[0]} 正在输入...`;
    }
    return `${usernames.slice(0, 2).join('、')} 等 ${usernames.length} 人正在输入...`;
  }, [typingUsers]);

  const onlinePeers = useMemo(
    () => Object.values(peers).sort((left, right) => left.username.localeCompare(right.username)),
    [peers],
  );

  const peerCount = Object.keys(peers).length;

  return {
    messages,
    messageReadReceipts,
    hasMoreHistory,
    historyLoading,
    isRoomSwitching,
    peers,
    onlinePeers,
    peerCount,
    peerSafetyNumbers,
    typingIndicatorText,
    roomSearchQuery,
    setRoomSearchQuery,
    roomSearchMatches,
    activeSearchResultIndex,
    setActiveSearchResultIndex,
    messageListRef,
    messageEndRef,
    focusMessageID,
    lastReadMessageID,
    unreadIncomingCount,
    timelineItems,
    emitTypingStatus,
    handleLoadMoreHistory,
    handleMessageListScroll,
    handleJumpToLatest,
    handleFocusMessageHandled,
    handleSearchPrev,
    handleSearchNext,
    handleEditMessage,
    handleRevokeMessage,
    handleRequestDecryptRecovery,
    resetReplyAndFocusState,
    setFocusMessageID,
  };
}
