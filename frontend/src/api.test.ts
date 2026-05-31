import { ApiClient, ApiError } from './api';

describe('ApiClient', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it('attaches csrf header for write requests when cookie is present', async () => {
    Object.defineProperty(globalThis, 'document', {
      value: {
        cookie: 'e2ee-chat.csrf=csrf-token-value',
      },
      configurable: true,
    });

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers ?? {});
      expect(headers.get('X-CSRF-Token')).toBe('csrf-token-value');
      return new Response(JSON.stringify({ loggedOut: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const api = new ApiClient('https://chat.example.com');
    await api.logout();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('builds fetchMessages query with clamped limit and beforeId', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain('/api/rooms/9/messages?limit=200&beforeId=123');
      return new Response(JSON.stringify({ messages: [], hasMore: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const api = new ApiClient('https://chat.example.com');
    const result = await api.fetchMessages(9, { limit: 999, beforeMessageID: 123.8 });

    expect(result.messages).toEqual([]);
    expect(result.hasMore).toBe(false);
  });

  it('builds safety number query for a specific target device', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toBe('https://chat.example.com/api/signal/safety-number/42?deviceId=phone-1');
      return new Response(JSON.stringify({
        localUserId: 1,
        targetUserId: 42,
        localIdentityKeyJwk: {},
        targetIdentityKeyJwk: {},
        localIdentityFingerprint: 'local',
        targetIdentityFingerprint: 'target',
        localIdentityUpdatedAt: '2026-05-28T00:00:00.000Z',
        targetIdentityUpdatedAt: '2026-05-28T00:00:00.000Z',
        safetyNumber: '12345',
        targetHistory: [],
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const api = new ApiClient('https://chat.example.com');
    const result = await api.fetchSignalSafetyNumber(42, ' phone-1 ');

    expect(result.safetyNumber).toBe('12345');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps network failures to ApiError(network)', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('network down');
    }) as unknown as typeof fetch;

    const api = new ApiClient('https://chat.example.com');

    await expect(api.session()).rejects.toMatchObject<ApiError>({
      code: 'network',
      status: null,
    });
  });

  it('maps http failure payload to ApiError(http)', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: 'forbidden' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch;

    const api = new ApiClient('https://chat.example.com');

    await expect(api.listUsers()).rejects.toMatchObject<ApiError>({
      code: 'http',
      status: 403,
      message: 'forbidden',
    });
  });

  it('updates the profile via PATCH with a JSON username body', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://chat.example.com/api/account/profile');
      expect(init?.method).toBe('PATCH');
      const headers = new Headers(init?.headers ?? {});
      expect(headers.get('Content-Type')).toBe('application/json');
      expect(init?.body).toBe(JSON.stringify({ username: 'bob' }));
      return new Response(JSON.stringify({
        user: { id: 7, username: 'bob', role: 'user' },
        device: {
          deviceId: 'device-1',
          deviceName: 'Browser',
          sessionVersion: 2,
          lastSeenAt: '2026-05-28T00:00:00.000Z',
        },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const api = new ApiClient('https://chat.example.com');
    const result = await api.updateProfile('bob');

    expect(result.user.username).toBe('bob');
    expect(result.device.deviceId).toBe('device-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('changes the password via POST with a JSON body', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe('https://chat.example.com/api/account/password');
      expect(init?.method).toBe('POST');
      const headers = new Headers(init?.headers ?? {});
      expect(headers.get('Content-Type')).toBe('application/json');
      expect(init?.body).toBe(JSON.stringify({ currentPassword: 'old-secret', newPassword: 'new-secret' }));
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const api = new ApiClient('https://chat.example.com');
    const result = await api.changePassword('old-secret', 'new-secret');

    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
