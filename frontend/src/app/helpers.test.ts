import { describe, expect, it } from 'vitest';
import { buildRecoveryRequestKey, formatRoomActivityLabel } from './helpers';

describe('buildRecoveryRequestKey', () => {
  it('includes sender device id when available', () => {
    const key = buildRecoveryRequestKey({
      roomId: 9,
      fromUserId: 12,
      messageId: 77,
      fromDeviceId: 'device-01',
    });

    expect(key).toBe('9:12:77:device-01');
  });

  it('falls back to wildcard key when sender device id is missing', () => {
    const key = buildRecoveryRequestKey({
      roomId: 9,
      fromUserId: 12,
      messageId: 77,
    });

    expect(key).toBe('9:12:77:*');
  });
});

describe('formatRoomActivityLabel', () => {
  const now = new Date('2026-05-16T12:00:00');

  it('formats same-day activity as local time', () => {
    expect(formatRoomActivityLabel('2026-05-16T09:30:00', now)).toMatch(/09:30|9:30/);
  });

  it('formats recent and older activity compactly', () => {
    expect(formatRoomActivityLabel('2026-05-15T09:30:00', now)).toBe('昨天');
    expect(formatRoomActivityLabel('2026-05-10T09:30:00', now)).toBe('5月10日');
    expect(formatRoomActivityLabel('2025-12-31T09:30:00', now)).toBe('2025年12月31日');
  });
});
