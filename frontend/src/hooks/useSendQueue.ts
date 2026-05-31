import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  ensureRatchetSessionsForRecipients,
  encryptForRecipientsWithContentKey,
  type Identity,
} from '../crypto';
import { buildRecipientAddress } from '../crypto/utils';
import type { SendQueueItem, UIMessage } from '../app/appTypes';
import { formatError } from '../app/helpers';
import { useChatStore } from '../stores/chatStore';
import type { Peer, User } from '../types';
import { rememberOutgoingPlaintext } from '../outgoingPlaintextCache';
import { estimatePendingWidth } from '../app/helpers';
import { persistOutgoingContentKey } from '../secureMessageStore';

type ValueOrUpdater<T> = T | ((previous: T) => T);

// Cap automatic re-queueing of failed sends. Identity rotates periodically, so
// without a cap a permanently failing item would silently churn forever. Items
// at/over the cap stay 'failed' and remain manually retryable.
export const MAX_SEND_ATTEMPTS = 5;

type UseSendQueueArgs = {
  authUserID: number | null;
  authDeviceID: string | null;
  identity: Identity | null;
  identityBound: boolean;
  selectedRoomID: number | null;
  wsConnected: boolean;
  setRoomMembers: (next: ValueOrUpdater<User[]>) => void;
  handshakeTick: number;
  peers: Record<string, Peer>;
  sendJSON: (frame: unknown) => boolean;
  apiListRoomMembers: (roomID: number) => Promise<{ roomId: number; members: User[] }>;
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
      oneTimePreKeyConsumed?: boolean;
      oneTimePreKeyLow?: boolean;
      oneTimePreKeysLeft?: number;
    }>;
    activeDeviceCount: number;
    readyDeviceCount: number;
    missingDeviceCount: number;
    updatedAt?: string;
  }>;
  reportError: (reason: unknown, fallback: string) => void;
  setError: (value: string) => void;
  setInfo: (value: string) => void;
  authUsername: string;
};

type UseSendQueueResult = {
  sendQueue: SendQueueItem[];
  failedQueueItems: SendQueueItem[];
  failedQueueCount: number;
  pendingQueueCount: number;
  replaceQueue: (nextQueue: SendQueueItem[]) => void;
  queueText: (text: string) => SendQueueItem;
  clearQueue: (roomID?: number) => void;
  flushSendQueue: () => Promise<void>;
  retryQueueItem: (itemID: string) => void;
  discardQueueItem: (itemID: string) => void;
  retryAllFailedItems: () => void;
};

function createQueueItemID(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `q-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

export function filterQueueForRoom(sendQueue: SendQueueItem[], roomID: number | null): SendQueueItem[] {
  if (!roomID || roomID <= 0) {
    return [];
  }
  return sendQueue.filter((item) => item.roomID === roomID);
}

export function selectAutoRetryableFailedItems(sendQueue: SendQueueItem[]): SendQueueItem[] {
  return sendQueue.filter(
    (item) => item.status === 'failed' && item.attempts < MAX_SEND_ATTEMPTS,
  );
}

export function pendingRecipientCoverageError(pendingUserIDs: number[]): string | null {
  const deduped = [...new Set(
    pendingUserIDs
      .map((value) => Math.floor(value))
      .filter((value) => Number.isFinite(value) && value > 0),
  )].sort((left, right) => left - right);
  if (deduped.length === 0) {
    return null;
  }
  return `以下成员存在尚未完成安全初始化的活跃设备: ${deduped.join(',')}`;
}

export function useSendQueue({
  authUserID,
  authDeviceID,
  identity,
  identityBound,
  selectedRoomID,
  wsConnected,
  setRoomMembers,
  handshakeTick,
  peers,
  sendJSON,
  apiListRoomMembers,
  resolveSignalBundle,
  reportError,
  setError,
  setInfo,
  authUsername,
}: UseSendQueueArgs): UseSendQueueResult {
  const sendQueue = useChatStore((state) => state.sendQueue);
  const setLocalDraftMessages = useChatStore((state) => state.setLocalDraftMessages);
  const setSendQueue = useChatStore((state) => state.setSendQueue);

  const sendQueueRef = useRef<SendQueueItem[]>([]);
  const queueBusyRef = useRef(false);

  useEffect(() => {
    sendQueueRef.current = sendQueue;
  }, [sendQueue]);

  const replaceQueue = useCallback((nextQueue: SendQueueItem[]) => {
    sendQueueRef.current = nextQueue;
    setSendQueue(nextQueue);
  }, [setSendQueue]);

  const clearQueue = useCallback((roomID?: number) => {
    if (!roomID || roomID <= 0) {
      replaceQueue([]);
      setLocalDraftMessages([]);
      return;
    }
    replaceQueue(sendQueueRef.current.filter((item) => item.roomID !== roomID));
    setLocalDraftMessages((previous) => previous.filter((message) => message.roomId !== roomID));
  }, [replaceQueue, setLocalDraftMessages]);

  const buildLocalDraftMessage = useCallback((
    queueItemID: string,
    text: string,
    next: Partial<UIMessage> = {},
  ): UIMessage => {
    const now = new Date().toISOString();
    return {
      id: -Date.now(),
      roomId: selectedRoomID ?? 0,
      senderId: authUserID ?? 0,
      senderUsername: authUsername,
      createdAt: now,
      editedAt: null,
      revokedAt: null,
      payload: {
        version: 3,
        ciphertext: '',
        messageIv: '',
        wrappedKeys: {},
        senderPublicKeyJwk: (identity?.publicKeyJwk ?? {}) as JsonWebKey,
        senderSigningPublicKeyJwk: (identity?.signingPublicKeyJwk ?? {}) as JsonWebKey,
        contentType: 'text/plain',
        senderDeviceId: authDeviceID ?? '',
        encryptionScheme: 'DOUBLE_RATCHET_V1',
      },
      plaintext: text,
      decryptState: 'ok',
      pendingWidthPx: estimatePendingWidth(text),
      localQueueID: queueItemID,
      localStatus: 'queued',
      localSignature: queueItemID,
      ...next,
    };
  }, [authDeviceID, authUserID, authUsername, identity?.publicKeyJwk, identity?.signingPublicKeyJwk, selectedRoomID]);

  const appendLocalDraftMessage = useCallback((queueItemID: string, text: string) => {
    const draft = buildLocalDraftMessage(queueItemID, text);
    setLocalDraftMessages((previous) => {
      const filtered = previous.filter((message) => message.localQueueID !== queueItemID);
      return [...filtered, draft];
    });
  }, [buildLocalDraftMessage, setLocalDraftMessages]);

  const updateLocalMessage = useCallback((queueItemID: string, next: Partial<UIMessage>) => {
    setLocalDraftMessages((previous) =>
      previous.map((message) =>
        message.localQueueID === queueItemID
          ? { ...message, ...next }
          : message,
      ));
  }, [setLocalDraftMessages]);

  const removeLocalMessage = useCallback((queueItemID: string) => {
    setLocalDraftMessages((previous) =>
      previous.filter((message) => message.localQueueID !== queueItemID),
    );
  }, [setLocalDraftMessages]);

  const queueText = useCallback((text: string): SendQueueItem => {
    const queueItem: SendQueueItem = {
      id: createQueueItemID(),
      roomID: selectedRoomID ?? 0,
      text,
      status: 'queued',
      attempts: 0,
      lastError: null,
      createdAt: Date.now(),
    };
    replaceQueue([...sendQueueRef.current, queueItem]);
    appendLocalDraftMessage(queueItem.id, text);
    return queueItem;
  }, [appendLocalDraftMessage, replaceQueue, selectedRoomID]);

  const flushSendQueue = useCallback(async () => {
    if (queueBusyRef.current) {
      return;
    }
    if (!authUserID || !authDeviceID || !identity || !identityBound || !selectedRoomID) {
      if (!identityBound) {
        setError('本地安全身份与当前会话不一致，请刷新页面后重新登录');
      }
      return;
    }
    if (!wsConnected) {
      return;
    }
    if (filterQueueForRoom(sendQueueRef.current, selectedRoomID).length === 0) {
      return;
    }

    queueBusyRef.current = true;
    const safetyTimer = window.setTimeout(() => {
      queueBusyRef.current = false;
    }, 30000);
    const queuedAtStart = sendQueueRef.current.filter(
      (item) => item.roomID === selectedRoomID && item.status !== 'failed',
    ).length;

    try {
      while (true) {
        const target = sendQueueRef.current.find(
          (item) => item.roomID === selectedRoomID && item.status === 'queued',
        );
        if (!target) {
          break;
        }

        replaceQueue(
          sendQueueRef.current.map((item) =>
            item.id === target.id
              ? { ...item, status: 'sending', lastError: null }
              : item,
          ),
        );

        // Always fetch a fresh member list; fallback can cause partial encryption.
        const membersResult = await apiListRoomMembers(selectedRoomID).catch(() => {
          throw new Error('无法刷新房间成员，已停止发送以避免密钥不同步');
        });
        setRoomMembers(membersResult.members);
        const currentMembers = membersResult.members;

        let recipientUserIDs = [...new Set(
          currentMembers
            .map((member) => member.id)
            .filter((memberID) => Number.isFinite(memberID) && memberID > 0),
        )];
        if (!recipientUserIDs.includes(authUserID)) {
          recipientUserIDs = [authUserID, ...recipientUserIDs];
        }

        const sessionStatus = await ensureRatchetSessionsForRecipients(
          authUserID,
          authDeviceID,
          identity,
          recipientUserIDs,
          resolveSignalBundle,
        );
        const pendingCoverageError = pendingRecipientCoverageError(sessionStatus.pendingUserIDs);
        if (pendingCoverageError) {
          throw new Error(pendingCoverageError);
        }
        if (sessionStatus.readyRecipients.length === 0) {
          throw new Error('没有可用的加密接收设备，已停止发送');
        }

        const { payload, rawContentKey } = await encryptForRecipientsWithContentKey(
          target.text,
          authUserID,
          authDeviceID,
          identity,
          sessionStatus.readyRecipients,
        );
        if (payload.signature) {
          await rememberOutgoingPlaintext(authUserID, selectedRoomID, payload.signature, target.text);
          void persistOutgoingContentKey(authUserID, selectedRoomID, payload.signature, rawContentKey);
        }
        const missingRecipients = sessionStatus.readyRecipients
          .map((recipient) => buildRecipientAddress(recipient.userID, recipient.deviceID))
          .filter((address) => !(address in payload.wrappedKeys));
        if (missingRecipients.length > 0) {
          throw new Error(`发送中止：密钥封装不完整 (${missingRecipients.join(',')})`);
        }

        const sent = sendJSON({
          type: 'ciphertext',
          ...payload,
        });
        if (!sent) {
          throw new Error('WebSocket 未连接');
        }

        updateLocalMessage(target.id, {
          localStatus: 'sending',
          localSignature: payload.signature,
        });
        replaceQueue(sendQueueRef.current.filter((item) => item.id !== target.id));
      }

      if (
        filterQueueForRoom(sendQueueRef.current, selectedRoomID).length === 0
        && queuedAtStart > 1
      ) {
        setInfo(`已发送 ${queuedAtStart} 条排队消息`);
      }
    } catch (reason: unknown) {
      const sending = sendQueueRef.current.find(
        (item) => item.roomID === selectedRoomID && item.status === 'sending',
      );
      if (!sending) {
        reportError(reason, '加密或发送失败');
      } else {
        const message = formatError(reason, '发送失败，请重试') ?? '发送失败，请重试';
        replaceQueue(
          sendQueueRef.current.map((item) =>
            item.id === sending.id
              ? {
                ...item,
                status: 'failed',
                attempts: item.attempts + 1,
                lastError: message,
              }
              : item,
          ),
        );
        updateLocalMessage(sending.id, { localStatus: 'failed' });
        setError(message);
      }
    } finally {
      window.clearTimeout(safetyTimer);
      queueBusyRef.current = false;
    }
  }, [
    apiListRoomMembers,
    authDeviceID,
    authUserID,
    identity,
    identityBound,
    replaceQueue,
    reportError,
    resolveSignalBundle,
    selectedRoomID,
    sendJSON,
    setError,
    setInfo,
    setRoomMembers,
    updateLocalMessage,
    wsConnected,
  ]);

  const retryQueueItem = useCallback((itemID: string) => {
    updateLocalMessage(itemID, { localStatus: 'queued' });
    replaceQueue(
      sendQueueRef.current.map((item) =>
        item.id === itemID
          ? { ...item, status: 'queued', attempts: 0, lastError: null }
          : item,
      ),
    );
    void flushSendQueue();
  }, [flushSendQueue, replaceQueue, updateLocalMessage]);

  const discardQueueItem = useCallback((itemID: string) => {
    removeLocalMessage(itemID);
    replaceQueue(sendQueueRef.current.filter((item) => item.id !== itemID));
  }, [removeLocalMessage, replaceQueue]);

  const retryAllFailedItems = useCallback(() => {
    for (const item of sendQueueRef.current) {
      if (item.roomID === selectedRoomID && item.status === 'failed') {
        updateLocalMessage(item.id, { localStatus: 'queued' });
      }
    }
    replaceQueue(
      sendQueueRef.current.map((item) =>
        item.roomID === selectedRoomID && item.status === 'failed'
          ? { ...item, status: 'queued', attempts: 0, lastError: null }
          : item,
      ),
    );
    void flushSendQueue();
  }, [flushSendQueue, replaceQueue, selectedRoomID, updateLocalMessage]);

  useEffect(() => {
    if (!sendQueue.some((item) => item.roomID === selectedRoomID && item.status === 'queued') || !wsConnected) {
      return;
    }
    void flushSendQueue();
  }, [flushSendQueue, handshakeTick, peers, selectedRoomID, sendQueue, wsConnected]);

  useEffect(() => {
    if (!identity || !identityBound || !wsConnected) {
      return;
    }
    // Only auto-re-queue failures that have not exhausted their retry budget,
    // and preserve lastError so the user still sees why the send failed. Items
    // at/over the cap stay 'failed' and can only be retried manually.
    const pending = selectAutoRetryableFailedItems(sendQueueRef.current);
    if (pending.length === 0) {
      return;
    }
    replaceQueue(
      sendQueueRef.current.map((item) =>
        pending.some((target) => target.id === item.id)
          ? { ...item, status: 'queued' }
          : item,
      ),
    );
  }, [identity, identityBound, replaceQueue, wsConnected]);

  const selectedRoomQueue = useMemo(
    () => filterQueueForRoom(sendQueue, selectedRoomID),
    [selectedRoomID, sendQueue],
  );

  const failedQueueItems = useMemo(
    () => selectedRoomQueue.filter((item) => item.status === 'failed'),
    [selectedRoomQueue],
  );

  const failedQueueCount = failedQueueItems.length;
  const pendingQueueCount = useMemo(
    () => selectedRoomQueue.filter((item) => item.status !== 'failed').length,
    [selectedRoomQueue],
  );

  return {
    sendQueue: selectedRoomQueue,
    failedQueueItems,
    failedQueueCount,
    pendingQueueCount,
    replaceQueue,
    queueText,
    clearQueue,
    flushSendQueue,
    retryQueueItem,
    discardQueueItem,
    retryAllFailedItems,
  };
}
