import { useCallback } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import type { Identity } from '../../crypto';
import type { ApiClient } from '../../api';
import type { AuthSession } from '../../contexts/AuthContext';
import { useMessages } from '../../hooks/useMessages';
import { useRooms } from '../../hooks/useRooms';
import { useSendQueue } from '../../hooks/useSendQueue';
import type { QuoteReplyPayload } from '../../components/ChatTimeline';
import type { Peer } from '../../types';

type UseChatRouteDataControllersArgs = {
  api: ApiClient;
  auth: AuthSession | null;
  routeMode: 'chat' | 'admin';
  roomIDFromRoute: number | null;
  navigate: NavigateFunction;
  chatPathForRoom: (roomID: number | null) => string;
  reportError: (reason: unknown, fallback: string) => void;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string>>;
  setInfo: Dispatch<SetStateAction<string>>;
  closeSidebar: () => void;
  onAuthReset: () => void;
  identity: Identity | null;
  identityBound: boolean;
  handshakeTick: number;
  bumpHandshakeTick: () => void;
  wsConnected: boolean;
  peers: Record<string, Peer>;
  sendJSON: (frame: unknown) => boolean;
  connect: (params: { roomID: number }) => void;
  disconnect: (reason?: string) => void;
  subscribeMessage: (listener: (frame: Record<string, unknown>) => void) => () => void;
  subscribeOpen: (listener: () => void) => () => void;
  notificationPermission: NotificationPermission;
  setPeerPanelOpen: Dispatch<SetStateAction<boolean>>;
  setReplyTarget: Dispatch<SetStateAction<QuoteReplyPayload | null>>;
  setDraft: Dispatch<SetStateAction<string>>;
  typingIdleTimerRef: MutableRefObject<number | null>;
};

export function useChatRouteDataControllers({
  api,
  auth,
  routeMode,
  roomIDFromRoute,
  navigate,
  chatPathForRoom,
  reportError,
  setBusy,
  setError,
  setInfo,
  closeSidebar,
  onAuthReset,
  identity,
  identityBound,
  handshakeTick,
  bumpHandshakeTick,
  wsConnected,
  peers,
  sendJSON,
  connect,
  disconnect,
  subscribeMessage,
  subscribeOpen,
  notificationPermission,
  setPeerPanelOpen,
  setReplyTarget,
  setDraft,
  typingIdleTimerRef,
}: UseChatRouteDataControllersArgs) {
  const roomsController = useRooms({
    api,
    auth,
    routeMode,
    roomIDFromRoute,
    navigate,
    chatPathForRoom,
    reportError,
    setBusy,
    setError,
    setInfo,
    closeSidebar,
    onAuthReset,
  });

  const resolveSignalBundle = useCallback(async (targetUserID: number) => {
    return api.fetchSignalPreKeyBundle(targetUserID);
  }, [api]);

  const sendQueueController = useSendQueue({
    authUserID: auth?.user.id ?? null,
    authDeviceID: auth?.device.deviceId ?? null,
    identity,
    identityBound,
    selectedRoomID: roomsController.selectedRoomID,
    wsConnected,
    setRoomMembers: roomsController.setRoomMembers,
    handshakeTick,
    peers,
    sendJSON,
    apiListRoomMembers: (roomID) => api.listRoomMembers(roomID),
    resolveSignalBundle,
    reportError,
    setError,
    setInfo,
  });
  const { clearQueue } = sendQueueController;

  const handleRoomSwitch = useCallback(() => {
    clearQueue();
    setPeerPanelOpen(false);
    setReplyTarget(null);
    setDraft('');
    if (typingIdleTimerRef.current !== null) {
      window.clearTimeout(typingIdleTimerRef.current);
      typingIdleTimerRef.current = null;
    }
  }, [clearQueue, setDraft, setPeerPanelOpen, setReplyTarget, typingIdleTimerRef]);

  const messagesController = useMessages({
    api,
    auth,
    identity,
    rooms: roomsController.rooms,
    selectedRoomID: roomsController.selectedRoomID,
    roomMembers: roomsController.roomMembers,
    wsConnected,
    sendJSON,
    connect,
    disconnect,
    subscribeMessage,
    subscribeOpen,
    handshakeTick,
    bumpHandshakeTick,
    resolveSignalBundle,
    reportError,
    setInfo,
    setError,
    notificationPermission,
    onRoomSwitch: handleRoomSwitch,
  });

  return {
    roomsController,
    sendQueueController,
    messagesController,
  };
}
