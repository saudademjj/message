import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useCryptoContext } from '../contexts/CryptoContext';
import { useWebSocketContext } from '../contexts/WebSocketContext';
import { useChatStore } from '../stores/chatStore';
import { ChatRouteLayout } from './chatRoute/ChatRouteLayout';
import { useAdminPanelController } from './chatRoute/useAdminPanelController';
import { useChatRouteActions } from './chatRoute/useChatRouteActions';
import { useComposerController } from './chatRoute/useComposerController';
import { useChatRouteDataControllers } from './chatRoute/useChatRouteDataControllers';
import { useChatRouteEffects } from './chatRoute/useChatRouteEffects';
import { useChatRouteState } from './chatRoute/useChatRouteState';
import { useProfileController } from './chatRoute/useProfileController';
import { useSessionScopedReset } from './chatRoute/useSessionScopedReset';
import type { ChatRoutePageProps } from './chatRoute/types';
import { useChatRouteViewModel } from './chatRoute/useChatRouteViewModel';

export function ChatRoutePage({ api, routeMode, roomIDFromRoute }: ChatRoutePageProps) {
  const navigate = useNavigate();
  const { auth, logout, refreshSession, updateAuthUser } = useAuth();
  const {
    identity,
    identityReady,
    identityBound,
    handshakeTick,
    bumpHandshakeTick,
    cryptoError,
    cryptoInfo,
    consumeCryptoError,
    consumeCryptoInfo,
  } = useCryptoContext();
  const {
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
  } = useWebSocketContext();

  const managedUsers = useChatStore((state) => state.managedUsers);
  const setManagedUsers = useChatStore((state) => state.setManagedUsers);
  const resetSessionScopedState = useChatStore((state) => state.resetSessionScopedState);
  const peers = useChatStore((state) => state.peers);

  // FIX: clear session-scoped store state on any auth user transition (forced
  // logout, session expiry, or account switch in the same tab), not only on the
  // manual logout button.
  useSessionScopedReset({
    authUserID: auth?.user.id ?? null,
    resetSessionScopedState,
  });

  const state = useChatRouteState({ setManagedUsers });

  const {
    busy,
    setBusy,
    error,
    setError,
    info,
    setInfo,
    setSidebarOpen,
    adminModalOpen,
    setAdminModalOpen,
    adminUserSearch,
    setAdminUserSearch,
    adminPage,
    setAdminPage,
    newManagedUsername,
    setNewManagedUsername,
    newManagedPassword,
    setNewManagedPassword,
    draft,
    setDraft,
    replyTarget,
    setReplyTarget,
    setPeerPanelOpen,
    setThemeMode,
    notificationPermission,
    setNotificationPermission,
    sidebarRef,
    peerPopoverRef,
    roomModalCardRef,
    adminModalCardRef,
    deviceModalCardRef,
    profileModalCardRef,
    draftInputRef,
    typingIdleTimerRef,
    chatPathForRoom,
    closeSidebar,
    reportError,
    onAuthReset,
  } = state;

  const { roomsController, sendQueueController, messagesController, devicesController } = useChatRouteDataControllers({
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
  });

  const adminController = useAdminPanelController({
    api,
    auth,
    managedUsers,
    setManagedUsers,
    setAdminModalOpen,
    adminUserSearch,
    setAdminUserSearch,
    adminPage,
    setAdminPage,
    newManagedUsername,
    setNewManagedUsername,
    newManagedPassword,
    setNewManagedPassword,
    setBusy,
    setError,
    setInfo,
    reportError,
  });

  // FIX: after a username change, force the active room socket to reconnect so
  // the backend re-reads the new username (it caches it at connect time). The
  // useMessages open-listener refetches room members on reconnect, so member
  // labels update too. Residual limitation: already-rendered historical message
  // bubbles keep the sender's old `senderUsername` until the room is refetched
  // or re-entered; this only guarantees forward propagation to peers + members.
  const handleProfileUpdated = useCallback(() => {
    const roomID = roomsController.selectedRoomID;
    if (!roomID || roomID <= 0 || !wsConnected) {
      return;
    }
    disconnect('username-changed');
    connect({ roomID });
  }, [roomsController.selectedRoomID, wsConnected, disconnect, connect]);

  const profileController = useProfileController({
    api,
    auth,
    refreshSession,
    updateAuthUser,
    setBusy,
    setInfo,
    setError,
    reportError,
    onProfileUpdated: handleProfileUpdated,
  });

  const composerController = useComposerController({
    auth,
    selectedRoomID: roomsController.selectedRoomID,
    draft,
    setDraft,
    replyTarget,
    setReplyTarget,
    typingIdleTimerRef,
    emitTypingStatus: messagesController.emitTypingStatus,
    queueText: sendQueueController.queueText,
    sendQueue: sendQueueController.sendQueue,
    flushSendQueue: sendQueueController.flushSendQueue,
    wsConnected,
    identity,
    identityBound,
    setInfo,
    setError,
    isMobileInputMode: state.isMobileInputMode,
    setFocusMessageID: messagesController.setFocusMessageID,
    draftInputRef,
  });

  const actions = useChatRouteActions({
    selectedRoomID: roomsController.selectedRoomID,
    chatPathForRoom,
    navigate,
    closeSidebar,
    disconnect,
    logout,
    resetSessionScopedState,
    clearQueue: sendQueueController.clearQueue,
    setNewManagedUsername,
    setNewManagedPassword,
    setAdminModalOpen,
    setAdminUserSearch,
    setAdminPage,
    setPeerPanelOpen,
    setReplyTarget,
    setDraft,
    setInfo,
    setError,
    setThemeMode,
    setNotificationPermission,
    roomsController,
    messagesController,
    typingIdleTimerRef,
  });

  useChatRouteEffects({
    sidebarRef,
    peerPopoverRef,
    roomModalCardRef,
    adminModalCardRef,
    deviceModalCardRef,
    profileModalCardRef,
    sidebarOpen: state.sidebarOpen,
    isMobileInputMode: state.isMobileInputMode,
    peerPanelOpen: state.peerPanelOpen,
    roomModalOpen: roomsController.roomModalOpen,
    adminModalOpen,
    deviceModalOpen: devicesController.deviceModalOpen,
    profileModalOpen: profileController.profileModalOpen,
    themeMode: state.themeMode,
    error,
    info,
    pushToast: state.pushToast,
    setError,
    setInfo,
    cryptoError,
    consumeCryptoError,
    cryptoInfo,
    consumeCryptoInfo,
    wsError,
    clearWsError,
    setNotificationPermission,
    auth,
    routeMode,
    navigate,
    chatPathForRoom,
    selectedRoomID: roomsController.selectedRoomID,
    setAdminUserSearch,
    setAdminPage,
    setAdminModalOpen,
    setRoomModalOpen: roomsController.setRoomModalOpen,
    setPeerPanelOpen,
    closeDeviceModal: devicesController.closeDeviceModal,
    closeProfileModal: profileController.closeProfileModal,
    closeSidebar,
    setIsMobileInputMode: state.setIsMobileInputMode,
    setSidebarOpen,
    draftInputRef,
    draft,
    replyTarget,
  });

  const viewModel = useChatRouteViewModel({
    wsConnected,
    reconnectCountdownSec,
    wsAuthProbeFailed,
    identity,
    failedQueueItems: sendQueueController.failedQueueItems,
    roomSearchQuery: messagesController.roomSearchQuery,
    roomSearchMatches: messagesController.roomSearchMatches,
    activeSearchResultIndex: messagesController.activeSearchResultIndex,
    hasMoreHistory: messagesController.hasMoreHistory,
  });

  if (!auth) {
    return null;
  }

  return (
    <ChatRouteLayout
      authUser={auth.user}
      authDevice={auth.device}
      managedUsersCount={managedUsers.length}
      busy={busy}
      roomsController={roomsController}
      messagesController={messagesController}
      sendQueueController={sendQueueController}
      devicesController={devicesController}
      adminController={adminController}
      composerController={composerController}
      profileController={profileController}
      viewModel={viewModel}
      ui={{
        sidebarOpen: state.sidebarOpen,
        closeSidebar: state.closeSidebar,
        toggleSidebar: state.toggleSidebar,
        sidebarRef: state.sidebarRef,
        peerPanelOpen: state.peerPanelOpen,
        peerPopoverRef: state.peerPopoverRef,
        roomModalCardRef: state.roomModalCardRef,
        adminModalCardRef: state.adminModalCardRef,
        deviceModalCardRef: state.deviceModalCardRef,
        profileModalCardRef: state.profileModalCardRef,
        adminModalOpen,
        adminUserSearch,
        setAdminUserSearch,
        adminPage,
        setAdminPage,
        newManagedUsername,
        setNewManagedUsername,
        newManagedPassword,
        setNewManagedPassword,
        draft,
        draftInputRef,
        isMobileInputMode: state.isMobileInputMode,
        themeMode: state.themeMode,
        notificationPermission,
        replyTarget,
        toasts: state.toasts,
        pauseToastDismissal: state.pauseToastDismissal,
        resumeToastDismissal: state.resumeToastDismissal,
        dismissToast: state.dismissToast,
      }}
      actions={actions}
      identityReady={identityReady}
      wsConnected={wsConnected}
    />
  );
}
