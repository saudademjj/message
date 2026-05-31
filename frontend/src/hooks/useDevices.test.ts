import { describe, expect, it } from 'vitest';
import type { DeviceSnapshot } from '../types';
import { sortDeviceSnapshots } from './useDevices';

function device(
  deviceId: string,
  lastSeenAt: string,
  revokedAt: string | null = null,
): DeviceSnapshot {
  return {
    deviceId,
    deviceName: deviceId,
    sessionVersion: 1,
    createdAt: '2026-05-17T00:00:00Z',
    lastSeenAt,
    trustStatus: 'approved',
    revokedAt,
    current: false,
  };
}

describe('sortDeviceSnapshots', () => {
  it('keeps active devices first and orders them by recency', () => {
    expect(sortDeviceSnapshots([
      device('old-active', '2026-05-16T08:00:00Z'),
      device('revoked', '2026-05-17T08:00:00Z', '2026-05-17T08:30:00Z'),
      device('new-active', '2026-05-17T09:00:00Z'),
    ]).map((item) => item.deviceId)).toEqual([
      'new-active',
      'old-active',
      'revoked',
    ]);
  });
});
