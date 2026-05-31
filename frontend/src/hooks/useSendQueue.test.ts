import { describe, expect, it } from 'vitest';
import type { SendQueueItem } from '../app/appTypes';
import {
  MAX_SEND_ATTEMPTS,
  filterQueueForRoom,
  pendingRecipientCoverageError,
  selectAutoRetryableFailedItems,
} from './useSendQueue';

function queueItem(id: string, roomID: number): SendQueueItem {
  return {
    id,
    roomID,
    text: id,
    status: 'queued',
    attempts: 0,
    lastError: null,
    createdAt: 1,
  };
}

function failedItem(id: string, attempts: number, lastError: string | null): SendQueueItem {
  return {
    id,
    roomID: 1,
    text: id,
    status: 'failed',
    attempts,
    lastError,
    createdAt: 1,
  };
}

describe('filterQueueForRoom', () => {
  it('keeps queued messages isolated to their original room', () => {
    expect(filterQueueForRoom([
      queueItem('room-1-a', 1),
      queueItem('room-2-a', 2),
      queueItem('room-1-b', 1),
    ], 1)).toEqual([
      queueItem('room-1-a', 1),
      queueItem('room-1-b', 1),
    ]);
  });

  it('returns no queue items when there is no active room', () => {
    expect(filterQueueForRoom([queueItem('room-1-a', 1)], null)).toEqual([]);
  });
});

describe('pendingRecipientCoverageError', () => {
  it('blocks sends until every active device is ready', () => {
    expect(pendingRecipientCoverageError([3, 2, 3])).toBe(
      '以下成员存在尚未完成安全初始化的活跃设备: 2,3',
    );
  });

  it('returns null when no recipient is pending', () => {
    expect(pendingRecipientCoverageError([])).toBeNull();
  });
});

describe('selectAutoRetryableFailedItems', () => {
  it('only re-queues failed items below the attempt cap', () => {
    const selectable = selectAutoRetryableFailedItems([
      failedItem('under-cap', MAX_SEND_ATTEMPTS - 1, 'boom'),
      failedItem('at-cap', MAX_SEND_ATTEMPTS, 'boom'),
      failedItem('over-cap', MAX_SEND_ATTEMPTS + 2, 'boom'),
    ]);
    expect(selectable.map((item) => item.id)).toEqual(['under-cap']);
  });

  it('ignores items that are not in a failed state', () => {
    const selectable = selectAutoRetryableFailedItems([
      queueItem('queued', 1),
      { ...queueItem('sending', 1), status: 'sending' },
      failedItem('failed', 0, 'boom'),
    ]);
    expect(selectable.map((item) => item.id)).toEqual(['failed']);
  });

  it('preserves the original items (and their lastError) for re-queueing', () => {
    const item = failedItem('keep-error', 1, '发送失败，请重试');
    const [selected] = selectAutoRetryableFailedItems([item]);
    expect(selected.lastError).toBe('发送失败，请重试');
  });
});
