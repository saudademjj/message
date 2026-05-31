import { describe, expect, it, vi } from 'vitest';
import type { UIMessage } from '../app/appTypes';
import type { ChatMessage } from '../types';
import {
  compareMessagesForTimeline,
  fetchMissingMessagesAfterCursor,
  findFirstUnreadIncomingMessageID,
  findLatestServerMessageID,
  mergeMessagesByID,
} from './useMessages';

describe('findFirstUnreadIncomingMessageID', () => {
  const messages = [
    { id: 10, senderId: 1 },
    { id: 11, senderId: 2 },
    { id: 12, senderId: 2 },
    { id: 13, senderId: 1 },
  ];

  it('returns the first unread incoming message after the local read cursor', () => {
    expect(findFirstUnreadIncomingMessageID(messages, 1, 10)).toBe(11);
  });

  it('returns null once all incoming messages are already read', () => {
    expect(findFirstUnreadIncomingMessageID(messages, 1, 12)).toBeNull();
  });
});

describe('compareMessagesForTimeline', () => {
  const baseMessage = {
    roomId: 1,
    senderId: 1,
    senderUsername: 'alice',
    editedAt: null,
    revokedAt: null,
    payload: {
      version: 3,
      ciphertext: '',
      messageIv: '',
      wrappedKeys: {},
      senderPublicKeyJwk: {},
    },
    plaintext: 'hello',
    decryptState: 'ok',
    pendingWidthPx: 110,
  } satisfies Omit<UIMessage, 'id' | 'createdAt'>;

  it('keeps local draft messages after server messages even with negative ids', () => {
    const serverMessage: UIMessage = {
      ...baseMessage,
      id: 42,
      createdAt: '2026-05-17T10:00:00.000Z',
    };
    const localDraft: UIMessage = {
      ...baseMessage,
      id: -100,
      createdAt: '2026-05-17T09:00:00.000Z',
      localQueueID: 'q-1',
      localStatus: 'sending',
    };

    expect([localDraft, serverMessage].sort(compareMessagesForTimeline)).toEqual([
      serverMessage,
      localDraft,
    ]);
  });
});

describe('findLatestServerMessageID', () => {
  const baseMessage = {
    roomId: 1,
    senderId: 1,
    senderUsername: 'alice',
    editedAt: null,
    revokedAt: null,
    payload: {
      version: 3,
      ciphertext: '',
      messageIv: '',
      wrappedKeys: {},
      senderPublicKeyJwk: {},
    },
    plaintext: 'hello',
    decryptState: 'ok',
    pendingWidthPx: 110,
  } satisfies Omit<UIMessage, 'id' | 'createdAt'>;

  it('ignores local drafts when choosing the sync cursor', () => {
    expect(findLatestServerMessageID([
      {
        ...baseMessage,
        id: 7,
        createdAt: '2026-05-17T10:00:00.000Z',
      },
      {
        ...baseMessage,
        id: -100,
        createdAt: '2026-05-17T10:01:00.000Z',
        localQueueID: 'q-1',
        localStatus: 'sending',
      },
    ])).toBe(7);
  });

  it('returns null when only local drafts exist', () => {
    expect(findLatestServerMessageID([
      {
        ...baseMessage,
        id: -100,
        createdAt: '2026-05-17T10:01:00.000Z',
        localQueueID: 'q-1',
        localStatus: 'queued',
      },
    ])).toBeNull();
  });
});

describe('mergeMessagesByID', () => {
  const baseMessage = {
    roomId: 1,
    senderId: 1,
    senderUsername: 'alice',
    editedAt: null,
    revokedAt: null,
    payload: {
      version: 3,
      ciphertext: '',
      messageIv: '',
      wrappedKeys: {},
      senderPublicKeyJwk: {},
    },
    plaintext: 'hello',
    decryptState: 'ok',
    pendingWidthPx: 110,
  } satisfies Omit<UIMessage, 'id' | 'createdAt'>;

  it('keeps realtime messages that were not present in the initial history snapshot', () => {
    const realtime: UIMessage = {
      ...baseMessage,
      id: 9,
      createdAt: '2026-05-17T10:09:00.000Z',
      plaintext: 'latest',
    };
    const historical: UIMessage = {
      ...baseMessage,
      id: 8,
      createdAt: '2026-05-17T10:08:00.000Z',
      plaintext: 'older',
    };

    expect(mergeMessagesByID([realtime], [historical])).toEqual([historical, realtime]);
  });

  it('uses freshly loaded history for duplicate message ids', () => {
    const stale: UIMessage = {
      ...baseMessage,
      id: 8,
      createdAt: '2026-05-17T10:08:00.000Z',
      plaintext: 'stale',
    };
    const fresh: UIMessage = {
      ...stale,
      plaintext: 'fresh',
    };

    expect(mergeMessagesByID([stale], [fresh])).toEqual([fresh]);
  });

  it('keeps a readable realtime copy when replayed history cannot be decrypted', () => {
    const readable: UIMessage = {
      ...baseMessage,
      id: 8,
      createdAt: '2026-05-17T10:08:00.000Z',
      plaintext: 'readable',
    };
    const failedReplay: UIMessage = {
      ...readable,
      plaintext: 'failed',
      decryptState: 'failed',
    };

    expect(mergeMessagesByID([readable], [failedReplay])).toEqual([readable]);
  });
});

describe('fetchMissingMessagesAfterCursor', () => {
  const buildMessage = (id: number): ChatMessage => ({
    id,
    roomId: 1,
    senderId: 2,
    senderUsername: 'bob',
    createdAt: `2026-05-17T10:${String(id).padStart(2, '0')}:00.000Z`,
    payload: {
      version: 3,
      ciphertext: '',
      messageIv: '',
      wrappedKeys: {},
      senderPublicKeyJwk: {},
    },
  });

  it('loads the latest page even when the local cursor is empty', async () => {
    const fetchPage = vi.fn(async (cursor: number | null) => ({
      messages: cursor === null ? [buildMessage(3), buildMessage(2)] : [],
    }));

    await expect(fetchMissingMessagesAfterCursor(fetchPage, null, 100)).resolves.toEqual([
      buildMessage(2),
      buildMessage(3),
    ]);
    expect(fetchPage).toHaveBeenCalledWith(null);
  });

  it('keeps paging until all messages after the cursor have been fetched', async () => {
    const fetchPage = vi.fn(async (cursor: number | null) => {
      if (cursor === 10) {
        return { messages: [buildMessage(12), buildMessage(11)] };
      }
      if (cursor === 12) {
        return { messages: [buildMessage(13)] };
      }
      return { messages: [] };
    });

    await expect(fetchMissingMessagesAfterCursor(fetchPage, 10, 2)).resolves.toEqual([
      buildMessage(11),
      buildMessage(12),
      buildMessage(13),
    ]);
    expect(fetchPage).toHaveBeenNthCalledWith(1, 10);
    expect(fetchPage).toHaveBeenNthCalledWith(2, 12);
  });
});
