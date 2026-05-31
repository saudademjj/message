import { useMemo } from 'react';

export type TimelineItem<TMessage> =
  | { kind: 'divider'; key: string; label: string }
  | { kind: 'unread'; key: string; label: string }
  | { kind: 'message'; key: string; message: TMessage };

type DayKeyResolver = (timestamp: string) => { key: string } | null;
type DayLabelFormatter = (timestamp: string) => string;

export function useTimelineItems<TMessage extends { id: number; createdAt: string }>(
  messages: TMessage[],
  resolveDayKey: DayKeyResolver,
  formatDayLabel: DayLabelFormatter,
  firstUnreadMessageID: number | null = null,
): TimelineItem<TMessage>[] {
  return useMemo(
    () => buildTimelineItems(messages, resolveDayKey, formatDayLabel, firstUnreadMessageID),
    [messages, resolveDayKey, formatDayLabel, firstUnreadMessageID],
  );
}

export function buildTimelineItems<TMessage extends { id: number; createdAt: string }>(
  messages: TMessage[],
  resolveDayKey: DayKeyResolver,
  formatDayLabel: DayLabelFormatter,
  firstUnreadMessageID: number | null = null,
): TimelineItem<TMessage>[] {
  const items: TimelineItem<TMessage>[] = [];
  let previousDayKey = '';
  for (const message of messages) {
    const parsed = resolveDayKey(message.createdAt);
    if (parsed && parsed.key !== previousDayKey) {
      items.push({
        kind: 'divider',
        key: `divider-${parsed.key}-${message.id}`,
        label: formatDayLabel(message.createdAt),
      });
      previousDayKey = parsed.key;
    }
    if (firstUnreadMessageID !== null && message.id === firstUnreadMessageID) {
      items.push({
        kind: 'unread',
        key: `unread-${message.id}`,
        label: '以下为未读消息',
      });
    }
    items.push({
      kind: 'message',
      key: `message-${message.id}`,
      message,
    });
  }
  return items;
}
