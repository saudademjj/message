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

type RoomConnectionParams = {
  roomID: number;
};

type WSMessageFrame = Record<string, unknown>;
type MessageListener = (frame: WSMessageFrame) => void;
type OpenListener = () => void;

type WebSocketContextValue = {
  wsConnected: boolean;
  reconnectCountdownSec: number | null;
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

type WebSocketProviderProps = {
  apiBase: string;
  children: ReactNode;
};

export function WebSocketProvider({ apiBase, children }: WebSocketProviderProps) {
  const wsBaseURL = useMemo(() => toWSBaseURL(apiBase), [apiBase]);
  const [wsConnected, setWsConnected] = useState(false);
  const [reconnectCountdownSec, setReconnectCountdownSec] = useState<number | null>(null);
  const [wsError, setWsError] = useState('');

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectIntervalRef = useRef<number | null>(null);
  const shouldReconnectRef = useRef(true);
  const connectParamsRef = useRef<RoomConnectionParams | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const startSocketRef = useRef<(params: RoomConnectionParams) => void>(() => { });
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

      if (event.code !== 1000) {
        let reason = 'WebSocket 连接中断';
        switch (event.code) {
          case 1006:
            reason = 'WebSocket 连接异常断开';
            break;
          case 1011:
            reason = '服务器内部错误';
            break;
          case 4001:
            reason = '认证失败或已过期';
            break;
          case 4003:
            reason = '拒绝访问当前房间';
            break;
          case 4004:
            reason = '已在其他端登录';
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
      clearReconnectTimers();
      const attempts = reconnectAttemptsRef.current;
      const delay = Math.min(
        WS_MAX_RECONNECT_DELAY_SECONDS,
        WS_INITIAL_RECONNECT_DELAY_SECONDS * Math.pow(2, attempts),
      );
      reconnectAttemptsRef.current += 1;

      setReconnectCountdownSec(delay);
      let remaining = delay;
      reconnectIntervalRef.current = window.setInterval(() => {
        remaining -= 1;
        setReconnectCountdownSec(Math.max(0, remaining));
      }, 1000);
      reconnectTimerRef.current = window.setTimeout(() => {
        const latest = connectParamsRef.current;
        clearReconnectTimers();
        setReconnectCountdownSec(null);
        if (latest && shouldReconnectRef.current) {
          startSocketRef.current(latest);
        }
      }, delay * 1000);
    };
  }, [clearReconnectTimers, safeCloseCurrentSocket, wsBaseURL]);

  useEffect(() => {
    startSocketRef.current = startSocket;
  }, [startSocket]);

  const connect = useCallback((params: RoomConnectionParams) => {
    connectParamsRef.current = params;
    shouldReconnectRef.current = true;
    startSocket(params);
  }, [startSocket]);

  const disconnect = useCallback((reason = 'disconnect') => {
    shouldReconnectRef.current = false;
    connectParamsRef.current = null;
    clearReconnectTimers();
    setReconnectCountdownSec(null);
    setWsConnected(false);
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
