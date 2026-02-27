import type {
  ChatMessage,
  DeviceSnapshot,
  Room,
  SafetyNumberSnapshot,
  SignalPreKeyBundleList,
  User,
} from './types';

type LoginResponse = {
  user: User;
  device: DeviceSessionInfo;
};

type SessionResponse = {
  user: User;
  device: DeviceSessionInfo;
};

type RoomsResponse = {
  rooms: Room[];
};

type RoomCreateResponse = {
  room: Room;
};

type RoomDeleteResponse = {
  deleted: boolean;
  roomId: number;
};

type MessagesResponse = {
  messages: ChatMessage[];
  hasMore?: boolean;
};

type RoomMembersResponse = {
  roomId: number;
  members: Array<User & { lastReadMessageId: number }>;
};

type FetchMessagesParams = {
  limit?: number;
  beforeMessageID?: number;
  afterMessageID?: number;
};

type RoomInviteResponse = {
  roomId: number;
  inviteToken: string;
  expiresAt: string;
};

type InviteJoinResponse = {
  joined: boolean;
  room: Room;
};

type AdminUsersResponse = {
  users: User[];
};

type AdminCreateUserResponse = {
  user: User;
};

type AdminDeleteUserResponse = {
  deleted: boolean;
  userId: number;
};

type LogoutResponse = {
  loggedOut: boolean;
};

type SignalPreKeyBundleUpload = {
  identityKeyJwk: JsonWebKey;
  identitySigningPublicKeyJwk: JsonWebKey;
  signedPreKey: {
    keyId: number;
    publicKeyJwk: JsonWebKey;
    signature: string;
  };
  oneTimePreKeys: Array<{
    keyId: number;
    publicKeyJwk: JsonWebKey;
  }>;
};

type SignalPreKeyUploadResponse = {
  ok: boolean;
  userId: number;
  signedPreKeyId: number;
  uploadedOneTimeKeys: number;
};

type DeviceSessionInfo = {
  deviceId: string;
  deviceName: string;
  sessionVersion: number;
  lastSeenAt: string;
};

type DevicesResponse = {
  devices: DeviceSnapshot[];
};

type DeviceMutationResponse = {
  device: DeviceSnapshot;
  revoked?: boolean;
  forcedLogout?: boolean;
};

export type ApiErrorCode = 'timeout' | 'aborted' | 'network' | 'http';

export type ApiRequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number | null;
  readonly serverCode: string | null;

  constructor(code: ApiErrorCode, message: string, status: number | null = null, serverCode: string | null = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.serverCode = serverCode;
  }
}

const DEFAULT_TIMEOUT_MS = Number(import.meta.env.VITE_API_TIMEOUT_MS ?? '12000');
const CSRF_COOKIE_KEY = 'e2ee-chat.csrf';

function normalizeTimeoutMs(value: number | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return Number.isFinite(DEFAULT_TIMEOUT_MS) && DEFAULT_TIMEOUT_MS > 0
      ? Math.floor(DEFAULT_TIMEOUT_MS)
      : 12000;
  }
  return Math.max(1000, Math.floor(parsed));
}

function isAbortLikeError(reason: unknown): boolean {
  return reason instanceof DOMException
    ? reason.name === 'AbortError'
    : reason instanceof Error
      ? reason.name === 'AbortError'
      : false;
}

function requiresCSRF(method: string): boolean {
  const normalized = method.trim().toUpperCase();
  return normalized !== 'GET' && normalized !== 'HEAD' && normalized !== 'OPTIONS';
}

function readCookieValue(key: string): string {
  if (typeof document === 'undefined') {
    return '';
  }
  const encodedKey = `${encodeURIComponent(key)}=`;
  const cookies = document.cookie ? document.cookie.split('; ') : [];
  for (const item of cookies) {
    if (item.startsWith(encodedKey)) {
      const rawValue = item.slice(encodedKey.length);
      try {
        return decodeURIComponent(rawValue);
      } catch {
        return rawValue;
      }
    }
  }
  return '';
}

async function parseJSON<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      typeof body?.error === 'string'
        ? body.error
        : typeof body?.message === 'string'
          ? body.message
          : `request failed: ${response.status}`;
    const serverCode = typeof body?.code === 'string' && body.code.trim()
      ? body.code.trim()
      : null;
    throw new ApiError('http', message, response.status, serverCode);
  }
  return body as T;
}

export function isApiAbortError(reason: unknown): boolean {
  return reason instanceof ApiError && reason.code === 'aborted';
}

export class ApiClient {
  private readonly baseURL: string;
  private refreshInFlight: Promise<boolean> | null = null;

  constructor(baseURL: string) {
    this.baseURL = baseURL;
  }

  private buildURL(path: string): string {
    return `${this.baseURL}${path}`;
  }

  private canAttemptRefresh(path: string, method: string): boolean {
    if (method === 'OPTIONS') {
      return false;
    }
    return path !== '/api/login'
      && path !== '/api/logout'
      && path !== '/api/refresh';
  }

  private async executeRequest(
    path: string,
    init: RequestInit = {},
    options: ApiRequestOptions = {},
  ): Promise<Response> {
    const timeoutMs = normalizeTimeoutMs(options.timeoutMs);
    const timeoutController = new AbortController();
    const upstreamSignal = options.signal;
    let timedOut = false;

    const onUpstreamAbort = () => {
      timeoutController.abort(upstreamSignal?.reason);
    };
    if (upstreamSignal) {
      if (upstreamSignal.aborted) {
        timeoutController.abort(upstreamSignal.reason);
      } else {
        upstreamSignal.addEventListener('abort', onUpstreamAbort, { once: true });
      }
    }

    const timeoutID = window.setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, timeoutMs);

    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers ?? {});
    if (requiresCSRF(method) && !headers.has('X-CSRF-Token')) {
      const csrfToken = readCookieValue(CSRF_COOKIE_KEY);
      if (csrfToken) {
        headers.set('X-CSRF-Token', csrfToken);
      }
    }

    try {
      return await fetch(this.buildURL(path), {
        ...init,
        method,
        headers,
        credentials: 'include',
        signal: timeoutController.signal,
      });
    } catch (reason: unknown) {
      if (isAbortLikeError(reason) || timeoutController.signal.aborted) {
        if (timedOut) {
          throw new ApiError('timeout', 'request timeout');
        }
        throw new ApiError('aborted', 'request aborted');
      }
      throw new ApiError('network', 'network request failed');
    } finally {
      window.clearTimeout(timeoutID);
      if (upstreamSignal) {
        upstreamSignal.removeEventListener('abort', onUpstreamAbort);
      }
    }
  }

  private async runRefresh(options: ApiRequestOptions): Promise<boolean> {
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }
    this.refreshInFlight = (async () => {
      const response = await this.executeRequest('/api/refresh', { method: 'POST' }, options);
      if (response.ok) {
        await response.json().catch(() => ({}));
        return true;
      }
      if (response.status === 401 || response.status === 403) {
        return false;
      }
      await parseJSON<Record<string, unknown>>(response);
      return false;
    })().finally(() => {
      this.refreshInFlight = null;
    });
    return this.refreshInFlight;
  }

  private async request(
    path: string,
    init: RequestInit = {},
    options: ApiRequestOptions = {},
  ): Promise<Response> {
    const method = (init.method ?? 'GET').toUpperCase();
    const response = await this.executeRequest(path, { ...init, method }, options);
    if (response.status !== 401 || !this.canAttemptRefresh(path, method)) {
      return response;
    }

    const refreshed = await this.runRefresh({ timeoutMs: options.timeoutMs });
    if (!refreshed) {
      return response;
    }
    return this.executeRequest(path, { ...init, method }, options);
  }

  async login(username: string, password: string, options: ApiRequestOptions = {}): Promise<LoginResponse> {
    const response = await this.request(
      '/api/login',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      },
      options,
    );
    return parseJSON<LoginResponse>(response);
  }

  async logout(options: ApiRequestOptions = {}): Promise<LogoutResponse> {
    const response = await this.request(
      '/api/logout',
      {
        method: 'POST',
      },
      options,
    );
    return parseJSON<LogoutResponse>(response);
  }

  async session(options: ApiRequestOptions = {}): Promise<SessionResponse> {
    const response = await this.request('/api/session', {}, options);
    return parseJSON<SessionResponse>(response);
  }

  async listRooms(options: ApiRequestOptions = {}): Promise<RoomsResponse> {
    const response = await this.request('/api/rooms', {}, options);
    return parseJSON<RoomsResponse>(response);
  }

  async createRoom(name: string, options: ApiRequestOptions = {}): Promise<RoomCreateResponse> {
    const response = await this.request(
      '/api/rooms',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name }),
      },
      options,
    );
    return parseJSON<RoomCreateResponse>(response);
  }

  async joinRoom(roomID: number, options: ApiRequestOptions = {}): Promise<void> {
    const response = await this.request(
      `/api/rooms/${roomID}/join`,
      {
        method: 'POST',
      },
      options,
    );
    await parseJSON<{ joined: boolean }>(response);
  }

  async createRoomInvite(
    roomID: number,
    options: ApiRequestOptions = {},
  ): Promise<RoomInviteResponse> {
    const response = await this.request(
      `/api/rooms/${roomID}/invite`,
      {
        method: 'POST',
      },
      options,
    );
    return parseJSON<RoomInviteResponse>(response);
  }

  async joinRoomByInvite(
    inviteToken: string,
    options: ApiRequestOptions = {},
  ): Promise<InviteJoinResponse> {
    const response = await this.request(
      '/api/invites/join',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ inviteToken }),
      },
      options,
    );
    return parseJSON<InviteJoinResponse>(response);
  }

  async deleteRoom(roomID: number, options: ApiRequestOptions = {}): Promise<RoomDeleteResponse> {
    const response = await this.request(
      `/api/rooms/${roomID}`,
      {
        method: 'DELETE',
      },
      options,
    );
    return parseJSON<RoomDeleteResponse>(response);
  }

  async fetchMessages(
    roomID: number,
    params: FetchMessagesParams = {},
    options: ApiRequestOptions = {},
  ): Promise<MessagesResponse> {
    const limit = Number.isFinite(params.limit) && Number(params.limit) > 0
      ? Math.min(200, Math.floor(Number(params.limit)))
      : 100;
    const query = new URLSearchParams();
    query.set('limit', String(limit));
    if (
      Number.isFinite(params.beforeMessageID) &&
      Number(params.beforeMessageID) > 0
    ) {
      query.set('beforeId', String(Math.floor(Number(params.beforeMessageID))));
    }
    if (
      Number.isFinite(params.afterMessageID) &&
      Number(params.afterMessageID) > 0
    ) {
      query.set('afterId', String(Math.floor(Number(params.afterMessageID))));
    }
    const response = await this.request(
      `/api/rooms/${roomID}/messages?${query.toString()}`,
      {},
      options,
    );
    return parseJSON<MessagesResponse>(response);
  }

  async listRoomMembers(roomID: number, options: ApiRequestOptions = {}): Promise<RoomMembersResponse> {
    const response = await this.request(
      `/api/rooms/${roomID}/members`,
      {},
      options,
    );
    return parseJSON<RoomMembersResponse>(response);
  }

  async publishSignalPreKeyBundle(
    bundle: SignalPreKeyBundleUpload,
    options: ApiRequestOptions = {},
  ): Promise<SignalPreKeyUploadResponse> {
    const response = await this.request(
      '/api/signal/prekey-bundle',
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(bundle),
      },
      options,
    );
    return parseJSON<SignalPreKeyUploadResponse>(response);
  }

  async fetchSignalPreKeyBundle(
    userID: number,
    options: ApiRequestOptions = {},
  ): Promise<SignalPreKeyBundleList> {
    const response = await this.request(
      `/api/signal/prekey-bundle/${userID}`,
      {},
      options,
    );
    return parseJSON<SignalPreKeyBundleList>(response);
  }

  async fetchSignalSafetyNumber(
    userID: number,
    options: ApiRequestOptions = {},
  ): Promise<SafetyNumberSnapshot> {
    const response = await this.request(
      `/api/signal/safety-number/${userID}`,
      {},
      options,
    );
    return parseJSON<SafetyNumberSnapshot>(response);
  }

  async listUsers(options: ApiRequestOptions = {}): Promise<AdminUsersResponse> {
    const response = await this.request('/api/admin/users', {}, options);
    return parseJSON<AdminUsersResponse>(response);
  }

  async createUser(
    username: string,
    password: string,
    options: ApiRequestOptions = {},
  ): Promise<AdminCreateUserResponse> {
    const response = await this.request(
      '/api/admin/users',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ username, password }),
      },
      options,
    );
    return parseJSON<AdminCreateUserResponse>(response);
  }

  async deleteUser(userID: number, options: ApiRequestOptions = {}): Promise<AdminDeleteUserResponse> {
    const response = await this.request(
      `/api/admin/users/${userID}`,
      {
        method: 'DELETE',
      },
      options,
    );
    return parseJSON<AdminDeleteUserResponse>(response);
  }

  async listDevices(options: ApiRequestOptions = {}): Promise<DevicesResponse> {
    const response = await this.request('/api/devices', {}, options);
    return parseJSON<DevicesResponse>(response);
  }

  async renameDevice(
    deviceID: string,
    deviceName: string,
    options: ApiRequestOptions = {},
  ): Promise<DeviceMutationResponse> {
    const response = await this.request(
      `/api/devices/${encodeURIComponent(deviceID)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deviceName }),
      },
      options,
    );
    return parseJSON<DeviceMutationResponse>(response);
  }

  async revokeDevice(deviceID: string, options: ApiRequestOptions = {}): Promise<DeviceMutationResponse> {
    const response = await this.request(
      `/api/devices/${encodeURIComponent(deviceID)}`,
      {
        method: 'DELETE',
      },
      options,
    );
    return parseJSON<DeviceMutationResponse>(response);
  }
}
