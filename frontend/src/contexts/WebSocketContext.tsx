/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ApiError, type ApiClient } from '../api';
import { useAuth } from './AuthContext';

type RoomConnectionParams = {
  roomID: number;
};

type WSMessageFrame = Record<string, unknown>;
type MessageListener = (frame: WSMessageFrame) => void;
type OpenListener = () => void;

type WebSocketContextValue = {
  wsConnected: boolean;
  reconnectCountdownSec: number | null;
  wsAuthProbeFailed: boolean;
  wsError: string;
  clearWsError: () => void;
  connect: (params: RoomConnectionParams) => void;
  disconnect: (reason?: string) => void;
  sendJSON: (frame: unknown) => boolean;
  subscribeMessage: (listener: MessageListener) => () => void;
  subscribeOpen: (listener: OpenListener) => () => void;
};

const WebSocketContext = createContext<WebSocketContextValue | null>(null);

const WS_INITIAL_RECONNECT_DELAY_SECONDS = 3;
const WS_MAX_RECONNECT_DELAY_SECONDS = 30;
const WS_AUTH_PROBE_TIMEOUT_MS = 8000;
const WS_RECONNECT_JITTER_MIN = 0.8;
const WS_RECONNECT_JITTER_MAX = 1.2;

function toWSBaseURL(httpBase: string): string {
  const trimmed = httpBase.replace(/\/$/, '');
  if (trimmed.startsWith('https://')) {
    return `wss://${trimmed.slice('https://'.length)}`;
  }
  if (trimmed.startsWith('http://')) {
    return `ws://${trimmed.slice('http://'.length)}`;
  }
  return trimmed;
}

function isBrowserOnline(): boolean {
  if (typeof navigator === 'undefined') {
    return true;
  }
  return navigator.onLine;
}

export function classifySessionProbeFailure(reason: unknown): 'expired' | 'retry' {
  if (reason instanceof ApiError && reason.code === 'http') {
    if (reason.status === 401 || reason.status === 403) {
      return 'expired';
    }
  }
  return 'retry';
}

export function computeReconnectDelaySeconds(attempts: number, randomValue = Math.random()): number {
  const normalizedAttempt = Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 0;
  const baseDelay = Math.min(
    WS_MAX_RECONNECT_DELAY_SECONDS,
    WS_INITIAL_RECONNECT_DELAY_SECONDS * Math.pow(2, normalizedAttempt),
  );
  const boundedRandom = Math.min(1, Math.max(0, randomValue));
  const jitterFactor = WS_RECONNECT_JITTER_MIN
    + ((WS_RECONNECT_JITTER_MAX - WS_RECONNECT_JITTER_MIN) * boundedRandom);
  return Math.max(1, Math.round(baseDelay * jitterFactor));
}

type WebSocketProviderProps = {
  api: ApiClient;
  apiBase: string;
  children: ReactNode;
};

export function WebSocketProvider({ api, apiBase, children }: WebSocketProviderProps) {
  const { logout } = useAuth();
  const wsBaseURL = useMemo(() => toWSBaseURL(apiBase), [apiBase]);
  const [wsConnected, setWsConnected] = useState(false);
  const [reconnectCountdownSec, setReconnectCountdownSec] = useState<number | null>(null);
  const [wsAuthProbeFailed, setWsAuthProbeFailed] = useState(false);
  const [wsError, setWsError] = useState('');

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectIntervalRef = useRef<number | null>(null);
  const shouldReconnectRef = useRef(true);
  const connectParamsRef = useRef<RoomConnectionParams | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const startSocketRef = useRef<(params: RoomConnectionParams) => void>(() => {});
  const scheduleReconnectRef = useRef<() => void>(() => {});
  const attemptReconnectRef = useRef<() => Promise<void>>(async () => {});
  const messageListenersRef = useRef<Set<MessageListener>>(new Set());
  const openListenersRef = useRef<Set<OpenListener>>(new Set());

  const clearReconnectTimers = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (reconnectIntervalRef.current !== null) {
      window.clearInterval(reconnectIntervalRef.current);
      reconnectIntervalRef.current = null;
    }
  }, []);

  const safeCloseCurrentSocket = useCallback((reason: string) => {
    const ws = wsRef.current;
    if (!ws) {
      return;
    }
    wsRef.current = null;
    try {
      ws.close(1000, reason.slice(0, 120));
    } catch {
      // Ignore close errors.
    }
  }, []);

  const markAuthExpired = useCallback((reason: string) => {
    shouldReconnectRef.current = false;
    connectParamsRef.current = null;
    clearReconnectTimers();
    setReconnectCountdownSec(null);
    setWsConnected(false);
    setWsAuthProbeFailed(true);
    setWsError(reason);
  }, [clearReconnectTimers]);

  const probeSessionBeforeReconnect = useCallback(async (): Promise<'ok' | 'expired' | 'retry'> => {
    try {
      await api.session({ timeoutMs: WS_AUTH_PROBE_TIMEOUT_MS });
      return 'ok';
    } catch (reason: unknown) {
      return classifySessionProbeFailure(reason);
    }
  }, [api]);

  const scheduleReconnect = useCallback(() => {
    if (!shouldReconnectRef.current || !connectParamsRef.current) {
      return;
    }
    if (!isBrowserOnline()) {
      clearReconnectTimers();
      setReconnectCountdownSec(null);
      setWsError('当前离线，网络恢复后将自动重连');
      return;
    }

    clearReconnectTimers();
    const attempt = reconnectAttemptsRef.current;
    const delay = computeReconnectDelaySeconds(attempt);
    reconnectAttemptsRef.current = Math.min(attempt + 1, 16);

    setReconnectCountdownSec(delay);
    let remaining = delay;
    reconnectIntervalRef.current = window.setInterval(() => {
      remaining -= 1;
      setReconnectCountdownSec(Math.max(0, remaining));
    }, 1000);

    reconnectTimerRef.current = window.setTimeout(() => {
      clearReconnectTimers();
      setReconnectCountdownSec(null);
      void attemptReconnectRef.current();
    }, delay * 1000);
  }, [clearReconnectTimers]);

  const startSocket = useCallback((params: RoomConnectionParams) => {
    clearReconnectTimers();
    setReconnectCountdownSec(null);
    safeCloseCurrentSocket('reconnect');
    setWsConnected(false);

    const socketURL = `${wsBaseURL}/ws?room_id=${params.roomID}`;
    const ws = new WebSocket(socketURL);
    wsRef.current = ws;

    ws.onopen = () => {
      if (wsRef.current !== ws) {
        return;
      }
      clearReconnectTimers();
      setReconnectCountdownSec(null);
      reconnectAttemptsRef.current = 0;
      setWsConnected(true);
      setWsAuthProbeFailed(false);
      setWsError('');
      for (const listener of openListenersRef.current) {
        listener();
      }
    };

    ws.onerror = () => {
      if (wsRef.current !== ws) {
        return;
      }
      setWsError('WebSocket 连接失败');
    };

    ws.onmessage = (event) => {
      if (wsRef.current !== ws) {
        return;
      }
      try {
        const frame = JSON.parse(String(event.data)) as WSMessageFrame;
        for (const listener of messageListenersRef.current) {
          listener(frame);
        }
      } catch {
        // Ignore malformed frames.
      }
    };

    ws.onclose = (event) => {
      if (wsRef.current === ws) {
        wsRef.current = null;
      }
      setWsConnected(false);

      if (event.code === 4001) {
        markAuthExpired('登录状态已失效，请重新登录');
        logout();
        return;
      }
      if (event.code === 4004) {
        markAuthExpired('账号已在其他设备登录，请重新登录');
        logout();
        return;
      }

      if (event.code !== 1000) {
        let reason = 'WebSocket 连接中断';
        switch (event.code) {
          case 1006:
            reason = 'WebSocket 连接异常断开';
            break;
          case 1011:
            reason = '服务器内部错误';
            break;
          case 4003:
            reason = '拒绝访问当前房间';
            break;
          default:
            if (event.reason) {
              reason = event.reason;
            }
        }
        setWsError(reason);
      }

      if (!shouldReconnectRef.current || !connectParamsRef.current) {
        return;
      }
      scheduleReconnectRef.current();
    };
  }, [clearReconnectTimers, logout, markAuthExpired, safeCloseCurrentSocket, wsBaseURL]);

  const attemptReconnect = useCallback(async () => {
    if (!shouldReconnectRef.current) {
      return;
    }
    const latest = connectParamsRef.current;
    if (!latest) {
      return;
    }
    if (!isBrowserOnline()) {
      setWsError('当前离线，网络恢复后将自动重连');
      return;
    }

    const probe = await probeSessionBeforeReconnect();
    if (probe === 'expired') {
      markAuthExpired('登录状态已失效，请重新登录');
      logout();
      return;
    }
    if (probe === 'retry') {
      scheduleReconnectRef.current();
      return;
    }

    startSocketRef.current(latest);
  }, [logout, markAuthExpired, probeSessionBeforeReconnect]);

  useEffect(() => {
    startSocketRef.current = startSocket;
  }, [startSocket]);

  useEffect(() => {
    scheduleReconnectRef.current = scheduleReconnect;
  }, [scheduleReconnect]);

  useEffect(() => {
    attemptReconnectRef.current = attemptReconnect;
  }, [attemptReconnect]);

  const connect = useCallback((params: RoomConnectionParams) => {
    connectParamsRef.current = params;
    shouldReconnectRef.current = true;
    reconnectAttemptsRef.current = 0;
    setWsAuthProbeFailed(false);
    startSocket(params);
  }, [startSocket]);

  const disconnect = useCallback((reason = 'disconnect') => {
    shouldReconnectRef.current = false;
    connectParamsRef.current = null;
    clearReconnectTimers();
    setReconnectCountdownSec(null);
    setWsConnected(false);
    setWsAuthProbeFailed(false);
    safeCloseCurrentSocket(reason);
  }, [clearReconnectTimers, safeCloseCurrentSocket]);

  const sendJSON = useCallback((frame: unknown): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    ws.send(JSON.stringify(frame));
    return true;
  }, []);

  const subscribeMessage = useCallback((listener: MessageListener) => {
    messageListenersRef.current.add(listener);
    return () => {
      messageListenersRef.current.delete(listener);
    };
  }, []);

  const subscribeOpen = useCallback((listener: OpenListener) => {
    openListenersRef.current.add(listener);
    return () => {
      openListenersRef.current.delete(listener);
    };
  }, []);

  const clearWsError = useCallback(() => {
    setWsError('');
  }, []);

  useEffect(() => {
    const onOnline = () => {
      if (!shouldReconnectRef.current || !connectParamsRef.current || wsRef.current) {
        return;
      }
      clearReconnectTimers();
      setReconnectCountdownSec(null);
      void attemptReconnectRef.current();
    };
    const onOffline = () => {
      if (!shouldReconnectRef.current || !connectParamsRef.current) {
        return;
      }
      clearReconnectTimers();
      setReconnectCountdownSec(null);
      setWsError('当前离线，网络恢复后将自动重连');
    };

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, [clearReconnectTimers]);

  useEffect(() => {
    const messageListeners = messageListenersRef.current;
    const openListeners = openListenersRef.current;
    return () => {
      shouldReconnectRef.current = false;
      clearReconnectTimers();
      safeCloseCurrentSocket('provider-unmount');
      messageListeners.clear();
      openListeners.clear();
    };
  }, [clearReconnectTimers, safeCloseCurrentSocket]);

  const value = useMemo<WebSocketContextValue>(() => ({
    wsConnected,
    reconnectCountdownSec,
    wsAuthProbeFailed,
    wsError,
    clearWsError,
    connect,
    disconnect,
    sendJSON,
    subscribeMessage,
    subscribeOpen,
  }), [
    wsConnected,
    reconnectCountdownSec,
    wsAuthProbeFailed,
    wsError,
    clearWsError,
    connect,
    disconnect,
    sendJSON,
    subscribeMessage,
    subscribeOpen,
  ]);

  return <WebSocketContext.Provider value={value}>{children}</WebSocketContext.Provider>;
}

export function useWebSocketContext(): WebSocketContextValue {
  const value = useContext(WebSocketContext);
  if (!value) {
    throw new Error('useWebSocketContext must be used within WebSocketProvider');
  }
  return value;
}
