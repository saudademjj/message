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
import type { ChatRoutePageProps } from './chatRoute/types';
import { useChatRouteViewModel } from './chatRoute/useChatRouteViewModel';

export function ChatRoutePage({ api, routeMode, roomIDFromRoute }: ChatRoutePageProps) {
  const navigate = useNavigate();
  const { auth, logout } = useAuth();
  const {
    identity,
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
    draftInputRef,
    typingIdleTimerRef,
    chatPathForRoom,
    closeSidebar,
    reportError,
    onAuthReset,
  } = state;

  const { roomsController, sendQueueController, messagesController } = useChatRouteDataControllers({
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
    sidebarOpen: state.sidebarOpen,
    isMobileInputMode: state.isMobileInputMode,
    peerPanelOpen: state.peerPanelOpen,
    roomModalOpen: roomsController.roomModalOpen,
    adminModalOpen,
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
      managedUsersCount={managedUsers.length}
      busy={busy}
      roomsController={roomsController}
      messagesController={messagesController}
      sendQueueController={sendQueueController}
      adminController={adminController}
      composerController={composerController}
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
      identityReady={Boolean(identity)}
      wsConnected={wsConnected}
    />
  );
}
