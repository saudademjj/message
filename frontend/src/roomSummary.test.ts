import { describe, expect, it } from 'vitest';
import { mergeRoomSummary, replaceRoomSummaries } from './roomSummary';
import type { Room } from './types';

function room(id: number, lastActivityAt: string, unreadCount = 0): Room {
  return {
    id,
    name: `room-${id}`,
    createdAt: '2026-05-15T08:00:00Z',
    lastMessageId: null,
    lastActivityAt,
    unreadCount,
  };
}

describe('room summary helpers', () => {
  it('replaces snapshots in activity order after reconnect', () => {
    expect(replaceRoomSummaries([
      room(1, '2026-05-15T08:00:00Z'),
      room(2, '2026-05-16T08:00:00Z'),
    ])).toEqual([
      room(2, '2026-05-16T08:00:00Z'),
      room(1, '2026-05-15T08:00:00Z'),
    ]);
  });

  it('merges an incremental update and moves the room forward', () => {
    const next = mergeRoomSummary([
      room(1, '2026-05-15T08:00:00Z'),
      room(2, '2026-05-14T08:00:00Z'),
    ], {
      ...room(2, '2026-05-16T08:00:00Z', 3),
      lastMessageId: 99,
    });

    expect(next.map((item) => item.id)).toEqual([2, 1]);
    expect(next[0].unreadCount).toBe(3);
    expect(next[0].lastMessageId).toBe(99);
  });
});
