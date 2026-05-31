import { describe, expect, it } from 'vitest';
import { isAuthSession } from './AuthContext';

describe('isAuthSession', () => {
  it('rejects empty fallback responses from a frontend-only dev server', () => {
    expect(isAuthSession({})).toBe(false);
  });

  it('accepts a complete authenticated session payload', () => {
    expect(isAuthSession({
      user: {
        id: 1,
        username: 'alice',
        role: 'user',
      },
      device: {
        deviceId: 'device-01',
        deviceName: 'Browser Device',
        sessionVersion: 1,
        lastSeenAt: '2026-05-16T08:00:00Z',
      },
    })).toBe(true);
  });
});
