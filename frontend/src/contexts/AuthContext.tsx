/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { isApiAbortError, type ApiClient } from '../api';
import type { User } from '../types';

export type AuthSession = {
  user: User;
  device: {
    deviceId: string;
    deviceName: string;
    sessionVersion: number;
    lastSeenAt: string;
  };
};

export function isAuthSession(value: unknown): value is AuthSession {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Partial<AuthSession>;
  return Boolean(
    candidate.user
    && typeof candidate.user.id === 'number'
    && typeof candidate.user.username === 'string'
    && (candidate.user.role === 'admin' || candidate.user.role === 'user')
    && candidate.device
    && typeof candidate.device.deviceId === 'string'
    && typeof candidate.device.deviceName === 'string'
    && typeof candidate.device.sessionVersion === 'number'
    && typeof candidate.device.lastSeenAt === 'string',
  );
}

type AuthContextValue = {
  auth: AuthSession | null;
  login: (username: string, password: string) => Promise<AuthSession>;
  logout: () => void;
  refreshSession: () => Promise<void>;
  updateAuthUser: (user: User) => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

type AuthProviderProps = {
  api: ApiClient;
  children: ReactNode;
};

export function AuthProvider({ api, children }: AuthProviderProps) {
  const [auth, setAuth] = useState<AuthSession | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    api.session({ signal: controller.signal })
      .then((session) => {
        if (!cancelled) {
          setAuth(isAuthSession(session) ? session : null);
        }
      })
      .catch((reason: unknown) => {
        if (cancelled || isApiAbortError(reason)) {
          return;
        }
        setAuth(null);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [api]);

  const login = useCallback(async (username: string, password: string): Promise<AuthSession> => {
    const session = await api.login(username.trim(), password);
    if (!isAuthSession(session)) {
      throw new Error('登录响应格式异常');
    }
    setAuth(session);
    return session;
  }, [api]);

  const logout = useCallback(() => {
    void api.logout().catch(() => {
      // Ignore network/logout race failures.
    });
    setAuth(null);
  }, [api]);

  const refreshSession = useCallback(async (): Promise<void> => {
    try {
      const session = await api.session();
      setAuth(isAuthSession(session) ? session : null);
    } catch (reason: unknown) {
      if (isApiAbortError(reason)) {
        return;
      }
      // Leave the existing auth state untouched on transient failures.
    }
  }, [api]);

  const updateAuthUser = useCallback((user: User) => {
    setAuth((previous) => (previous ? { ...previous, user } : previous));
  }, []);

  const value = useMemo<AuthContextValue>(() => ({
    auth,
    login,
    logout,
    refreshSession,
    updateAuthUser,
  }), [auth, login, logout, refreshSession, updateAuthUser]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return value;
}
