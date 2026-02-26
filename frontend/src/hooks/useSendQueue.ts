import { useCallback, useEffect, useMemo, useRef } from 'react';
import {
  ensureRatchetSessionsForRecipients,
  encryptForRecipients,
  type Identity,
} from '../crypto';
import { buildRecipientAddress } from '../crypto/utils';
import type { SendQueueItem } from '../app/appTypes';
import { formatError } from '../app/helpers';
import { useChatStore } from '../stores/chatStore';
import type { Peer, User } from '../types';
import { rememberOutgoingPlaintext } from '../outgoingPlaintextCache';

type ValueOrUpdater<T> = T | ((previous: T) => T);

type UseSendQueueArgs = {
  authUserID: number | null;
  identity: Identity | null;
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
    }>;
    updatedAt?: string;
  }>;
  reportError: (reason: unknown, fallback: string) => void;
  setError: (value: string) => void;
  setInfo: (value: string) => void;
};

type UseSendQueueResult = {
  sendQueue: SendQueueItem[];
  failedQueueItems: SendQueueItem[];
  failedQueueCount: number;
  pendingQueueCount: number;
  replaceQueue: (nextQueue: SendQueueItem[]) => void;
  queueText: (text: string) => SendQueueItem;
  clearQueue: () => void;
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

export function useSendQueue({
  authUserID,
  identity,
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
}: UseSendQueueArgs): UseSendQueueResult {
  const sendQueue = useChatStore((state) => state.sendQueue);
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

  const clearQueue = useCallback(() => {
    replaceQueue([]);
  }, [replaceQueue]);

  const queueText = useCallback((text: string): SendQueueItem => {
    const queueItem: SendQueueItem = {
      id: createQueueItemID(),
      text,
      status: 'queued',
      attempts: 0,
      lastError: null,
      createdAt: Date.now(),
    };
    replaceQueue([...sendQueueRef.current, queueItem]);
    return queueItem;
  }, [replaceQueue]);

  const flushSendQueue = useCallback(async () => {
    if (queueBusyRef.current) {
      return;
    }
    if (!authUserID || !identity || !selectedRoomID) {
      return;
    }
    if (!wsConnected) {
      return;
    }
    if (sendQueueRef.current.length === 0) {
      return;
    }

    queueBusyRef.current = true;
    const safetyTimer = window.setTimeout(() => {
      queueBusyRef.current = false;
    }, 30000);
    const queuedAtStart = sendQueueRef.current.filter((item) => item.status !== 'failed').length;

    try {
      while (true) {
        const target = sendQueueRef.current.find((item) => item.status === 'queued');
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
          identity.activeKeyID,
          identity,
          recipientUserIDs,
          resolveSignalBundle,
        );
        const pendingPeerIDs = sessionStatus.pendingUserIDs;
        if (pendingPeerIDs.length > 0) {
          const deduped = [...new Set(pendingPeerIDs)].sort((left, right) => left - right);
          throw new Error(`以下成员密钥会话未就绪: ${deduped.join(',')}`);
        }

        const payload = await encryptForRecipients(
          target.text,
          authUserID,
          identity.activeKeyID,
          identity,
          sessionStatus.readyRecipients,
        );
        if (payload.signature) {
          await rememberOutgoingPlaintext(authUserID, selectedRoomID, payload.signature, target.text);
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

        replaceQueue(sendQueueRef.current.filter((item) => item.id !== target.id));
      }

      if (sendQueueRef.current.length === 0 && queuedAtStart > 1) {
        setInfo(`已发送 ${queuedAtStart} 条排队消息`);
      }
    } catch (reason: unknown) {
      const sending = sendQueueRef.current.find((item) => item.status === 'sending');
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
        setError(message);
      }
    } finally {
      window.clearTimeout(safetyTimer);
      queueBusyRef.current = false;
    }
  }, [
    apiListRoomMembers,
    authUserID,
    identity,
    replaceQueue,
    reportError,
    resolveSignalBundle,
    selectedRoomID,
    sendJSON,
    setError,
    setInfo,
    setRoomMembers,
    wsConnected,
  ]);

  const retryQueueItem = useCallback((itemID: string) => {
    replaceQueue(
      sendQueueRef.current.map((item) =>
        item.id === itemID
          ? { ...item, status: 'queued', lastError: null }
          : item,
      ),
    );
    void flushSendQueue();
  }, [flushSendQueue, replaceQueue]);

  const discardQueueItem = useCallback((itemID: string) => {
    replaceQueue(sendQueueRef.current.filter((item) => item.id !== itemID));
  }, [replaceQueue]);

  const retryAllFailedItems = useCallback(() => {
    replaceQueue(
      sendQueueRef.current.map((item) =>
        item.status === 'failed'
          ? { ...item, status: 'queued', lastError: null }
          : item,
      ),
    );
    void flushSendQueue();
  }, [flushSendQueue, replaceQueue]);

  useEffect(() => {
    if (!sendQueue.some((item) => item.status === 'queued') || !wsConnected) {
      return;
    }
    void flushSendQueue();
  }, [flushSendQueue, handshakeTick, peers, sendQueue, wsConnected]);

  useEffect(() => {
    if (!identity || !wsConnected) {
      return;
    }
    const pending = sendQueueRef.current.filter((item) => item.status === 'failed');
    if (pending.length === 0) {
      return;
    }
    replaceQueue(
      sendQueueRef.current.map((item) =>
        pending.some((target) => target.id === item.id)
          ? { ...item, status: 'queued', lastError: null }
          : item,
      ),
    );
  }, [identity, replaceQueue, wsConnected]);

  const failedQueueItems = useMemo(
    () => sendQueue.filter((item) => item.status === 'failed'),
    [sendQueue],
  );

  const failedQueueCount = failedQueueItems.length;
  const pendingQueueCount = useMemo(
    () => sendQueue.filter((item) => item.status !== 'failed').length,
    [sendQueue],
  );

  return {
    sendQueue,
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
