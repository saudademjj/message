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
};

type AuthContextValue = {
  auth: AuthSession | null;
  login: (username: string, password: string) => Promise<AuthSession>;
  logout: () => void;
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
          setAuth(session);
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
    setAuth(session);
    return session;
  }, [api]);

  const logout = useCallback(() => {
    void api.logout().catch(() => {
      // Ignore network/logout race failures.
    });
    setAuth(null);
  }, [api]);

  const value = useMemo<AuthContextValue>(() => ({
    auth,
    login,
    logout,
  }), [auth, login, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return value;
}
