import { describe, expect, it } from 'vitest';
import { buildTimelineItems } from './useTimelineItems';

describe('buildTimelineItems', () => {
  const messages = [
    { id: 1, createdAt: '2026-05-15T08:00:00Z' },
    { id: 2, createdAt: '2026-05-15T09:00:00Z' },
    { id: 3, createdAt: '2026-05-16T08:00:00Z' },
  ];
  const resolveDayKey = (timestamp: string) => ({ key: timestamp.slice(0, 10) });
  const formatDayLabel = (timestamp: string) => timestamp.slice(0, 10);

  it('inserts an unread divider before the first unread message', () => {
    const items = buildTimelineItems(messages, resolveDayKey, formatDayLabel, 2);
    expect(items.map((item) => item.kind)).toEqual([
      'divider',
      'message',
      'unread',
      'message',
      'divider',
      'message',
    ]);
  });

  it('keeps the timeline unchanged when the unread message is outside the loaded window', () => {
    const items = buildTimelineItems(messages, resolveDayKey, formatDayLabel, 9);
    expect(items.some((item) => item.kind === 'unread')).toBe(false);
  });
});
