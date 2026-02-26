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
});
