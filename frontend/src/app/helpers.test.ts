import { describe, expect, it } from 'vitest';
import { buildRecoveryRequestKey } from './helpers';

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
