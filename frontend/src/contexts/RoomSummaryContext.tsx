import { useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { ApiClient } from '../api';
import { replaceRoomSummaries, mergeRoomSummary } from '../roomSummary';
import { useChatStore } from '../stores/chatStore';
import type { Room, RoomSummariesFrame, RoomSummaryUpdateFrame } from '../types';
import {
  classifySessionProbeFailure,
  computeReconnectDelaySeconds,
} from './WebSocketContext';
import { useAuth } from './AuthContext';

const WS_AUTH_PROBE_TIMEOUT_MS = 8000;

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

function applyLocalReadState(room: Room, authUserID: number): Room {
  const { localReadCursors, roomMembers, selectedRoomID } = useChatStore.getState();
  if (room.id !== selectedRoomID || room.lastMessageId === null) {
    return room;
  }
  const self = roomMembers.find((member) => member.id === authUserID);
  const localCursor = localReadCursors[room.id] ?? 0;
  const memberCursor = typeof self?.lastReadMessageId === 'number'
    ? self.lastReadMessageId
    : 0;
  const readCursor = Math.max(localCursor, memberCursor);
  if (readCursor < room.lastMessageId) {
    return room;
  }
  return {
    ...room,
    unreadCount: 0,
  };
}

type RoomSummaryProviderProps = {
  api: ApiClient;
  apiBase: string;
  children: ReactNode;
};

export function RoomSummaryProvider({ api, apiBase, children }: RoomSummaryProviderProps) {
  const { auth, logout } = useAuth();
  const wsBaseURL = useMemo(() => toWSBaseURL(apiBase), [apiBase]);
  const setRooms = useChatStore((state) => state.setRooms);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const shouldReconnectRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  const startSocketRef = useRef<() => void>(() => {});
  const scheduleReconnectRef = useRef<() => void>(() => {});

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
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

  const probeSessionBeforeReconnect = useCallback(async (): Promise<'ok' | 'expired' | 'retry'> => {
    try {
      await api.session({ timeoutMs: WS_AUTH_PROBE_TIMEOUT_MS });
      return 'ok';
    } catch (reason: unknown) {
      return classifySessionProbeFailure(reason);
    }
  }, [api]);

  const scheduleReconnect = useCallback(() => {
    if (!shouldReconnectRef.current || !auth || !isBrowserOnline()) {
      return;
    }
    clearReconnectTimer();
    const attempt = reconnectAttemptsRef.current;
    const delay = computeReconnectDelaySeconds(attempt);
    reconnectAttemptsRef.current = Math.min(attempt + 1, 16);
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      void (async () => {
        const probe = await probeSessionBeforeReconnect();
        if (probe === 'expired') {
          shouldReconnectRef.current = false;
          logout();
          return;
        }
        if (probe === 'retry') {
          scheduleReconnectRef.current();
          return;
        }
        startSocketRef.current();
      })();
    }, delay * 1000);
  }, [auth, clearReconnectTimer, logout, probeSessionBeforeReconnect]);

  const startSocket = useCallback(() => {
    if (!auth) {
      return;
    }
    clearReconnectTimer();
    safeCloseCurrentSocket('reconnect');
    const ws = new WebSocket(`${wsBaseURL}/ws/rooms`);
    wsRef.current = ws;

    ws.onopen = () => {
      if (wsRef.current !== ws) {
        return;
      }
      reconnectAttemptsRef.current = 0;
    };

    ws.onmessage = (event) => {
      if (wsRef.current !== ws) {
        return;
      }
      try {
        const frame = JSON.parse(String(event.data)) as RoomSummariesFrame | RoomSummaryUpdateFrame;
        if (frame.type === 'room_summaries' && Array.isArray(frame.rooms)) {
          setRooms(replaceRoomSummaries(
            frame.rooms.map((room) => applyLocalReadState(room, auth.user.id)),
          ));
          return;
        }
        if (frame.type === 'room_summary_update' && frame.room) {
          setRooms((previous) => mergeRoomSummary(previous, applyLocalReadState(frame.room, auth.user.id)));
        }
      } catch {
        // Ignore malformed frames.
      }
    };

    ws.onclose = (event) => {
      const isCurrentSocket = wsRef.current === ws;
      if (isCurrentSocket) {
        wsRef.current = null;
      }
      if (!isCurrentSocket) {
        return;
      }
      if (event.code === 4001 || event.code === 4004) {
        shouldReconnectRef.current = false;
        logout();
        return;
      }
      if (shouldReconnectRef.current) {
        scheduleReconnectRef.current();
      }
    };
  }, [auth, clearReconnectTimer, logout, safeCloseCurrentSocket, setRooms, wsBaseURL]);

  useEffect(() => {
    startSocketRef.current = startSocket;
  }, [startSocket]);

  useEffect(() => {
    scheduleReconnectRef.current = scheduleReconnect;
  }, [scheduleReconnect]);

  useEffect(() => {
    if (!auth) {
      shouldReconnectRef.current = false;
      reconnectAttemptsRef.current = 0;
      clearReconnectTimer();
      safeCloseCurrentSocket('auth-cleared');
      return;
    }
    shouldReconnectRef.current = true;
    reconnectAttemptsRef.current = 0;
    startSocket();
    return () => {
      shouldReconnectRef.current = false;
      clearReconnectTimer();
      safeCloseCurrentSocket('auth-changed');
    };
  }, [auth, clearReconnectTimer, safeCloseCurrentSocket, startSocket]);

  useEffect(() => {
    const onOnline = () => {
      if (!shouldReconnectRef.current || !auth || wsRef.current) {
        return;
      }
      clearReconnectTimer();
      startSocketRef.current();
    };
    window.addEventListener('online', onOnline);
    return () => {
      window.removeEventListener('online', onOnline);
    };
  }, [auth, clearReconnectTimer]);

  useEffect(() => () => {
    shouldReconnectRef.current = false;
    clearReconnectTimer();
    safeCloseCurrentSocket('provider-unmount');
  }, [clearReconnectTimer, safeCloseCurrentSocket]);

  return <>{children}</>;
}
