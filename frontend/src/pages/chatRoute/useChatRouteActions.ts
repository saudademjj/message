import { useCallback } from 'react';
import type { Dispatch, FormEvent, MutableRefObject, SetStateAction } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import type { UIMessage, ThemeMode } from '../../app/appTypes';
import type { QuoteReplyPayload } from '../../components/ChatTimeline';

type UseChatRouteActionsArgs = {
  selectedRoomID: number | null;
  chatPathForRoom: (roomID: number | null) => string;
  navigate: NavigateFunction;
  closeSidebar: () => void;
  disconnect: (reason?: string) => void;
  logout: () => void;
  resetSessionScopedState: () => void;
  clearQueue: () => void;
  setNewManagedUsername: Dispatch<SetStateAction<string>>;
  setNewManagedPassword: Dispatch<SetStateAction<string>>;
  setAdminModalOpen: Dispatch<SetStateAction<boolean>>;
  setAdminUserSearch: Dispatch<SetStateAction<string>>;
  setAdminPage: Dispatch<SetStateAction<number>>;
  setPeerPanelOpen: Dispatch<SetStateAction<boolean>>;
  setReplyTarget: Dispatch<SetStateAction<QuoteReplyPayload | null>>;
  setDraft: Dispatch<SetStateAction<string>>;
  setInfo: Dispatch<SetStateAction<string>>;
  setError: Dispatch<SetStateAction<string>>;
  setThemeMode: Dispatch<SetStateAction<ThemeMode>>;
  setNotificationPermission: Dispatch<SetStateAction<NotificationPermission>>;
  roomsController: {
    handleCopyInviteLink: () => Promise<void>;
    handleDeleteRoom: () => Promise<void>;
    setRoomModalOpen: Dispatch<SetStateAction<boolean>>;
    handleCreateRoom: (event: FormEvent<HTMLFormElement>) => Promise<void>;
    handleJoinRoom: (event: FormEvent<HTMLFormElement>) => Promise<void>;
  };
  messagesController: {
    handleEditMessage: (message: UIMessage) => Promise<void>;
  };
  typingIdleTimerRef: MutableRefObject<number | null>;
};

export function useChatRouteActions({
  selectedRoomID,
  chatPathForRoom,
  navigate,
  closeSidebar,
  disconnect,
  logout,
  resetSessionScopedState,
  clearQueue,
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
}: UseChatRouteActionsArgs) {
  const handleEnableNotifications = useCallback(async () => {
    if (typeof Notification === 'undefined') {
      setError('当前浏览器不支持通知');
      return;
    }
    try {
      const permission = await Notification.requestPermission();
      setNotificationPermission(permission);
      if (permission === 'granted') {
        setInfo('浏览器通知已开启');
      } else {
        setInfo('浏览器通知未开启');
      }
    } catch {
      setError('通知权限请求失败');
    }
  }, [setError, setInfo, setNotificationPermission]);

  const handleLogout = useCallback(() => {
    disconnect('logout');
    logout();
    resetSessionScopedState();
    clearQueue();
    setNewManagedUsername('');
    setNewManagedPassword('');
    closeSidebar();
    setAdminModalOpen(false);
    setAdminUserSearch('');
    setAdminPage(1);
    setPeerPanelOpen(false);
    roomsController.setRoomModalOpen(false);
    setReplyTarget(null);
    setDraft('');
    if (typingIdleTimerRef.current !== null) {
      window.clearTimeout(typingIdleTimerRef.current);
      typingIdleTimerRef.current = null;
    }
    setInfo('已退出登录');
    setError('');
    navigate('/login', { replace: true });
  }, [
    clearQueue,
    closeSidebar,
    disconnect,
    logout,
    navigate,
    resetSessionScopedState,
    roomsController,
    setAdminModalOpen,
    setAdminPage,
    setAdminUserSearch,
    setDraft,
    setError,
    setInfo,
    setNewManagedPassword,
    setNewManagedUsername,
    setPeerPanelOpen,
    setReplyTarget,
    typingIdleTimerRef,
  ]);

  const handleOpenAdminModal = useCallback(() => {
    closeSidebar();
    navigate('/admin');
  }, [closeSidebar, navigate]);

  const handleCopyInviteLinkWrapper = useCallback(() => {
    void roomsController.handleCopyInviteLink();
  }, [roomsController]);

  const handleDeleteRoomWrapper = useCallback(() => {
    void roomsController.handleDeleteRoom().then(() => {
      clearQueue();
    });
  }, [clearQueue, roomsController]);

  const handleEnableNotificationsWrapper = useCallback(() => {
    void handleEnableNotifications();
  }, [handleEnableNotifications]);

  const handleToggleThemeMode = useCallback(() => {
    setThemeMode((previous) => (previous === 'dark' ? 'light' : 'dark'));
  }, [setThemeMode]);

  const handleTogglePeerPanel = useCallback(() => {
    setPeerPanelOpen((previous) => !previous);
  }, [setPeerPanelOpen]);

  const handleClosePeerPanel = useCallback(() => {
    setPeerPanelOpen(false);
  }, [setPeerPanelOpen]);

  const handleEditMessageWrapper = useCallback((message: UIMessage) => {
    void messagesController.handleEditMessage(message);
  }, [messagesController]);

  const handleCloseRoomModal = useCallback(() => {
    roomsController.setRoomModalOpen(false);
  }, [roomsController]);

  const handleCreateRoomWrapper = useCallback((event: FormEvent<HTMLFormElement>) => {
    void roomsController.handleCreateRoom(event);
  }, [roomsController]);

  const handleJoinRoomWrapper = useCallback((event: FormEvent<HTMLFormElement>) => {
    void roomsController.handleJoinRoom(event);
  }, [roomsController]);

  const handleCloseAdminModal = useCallback(() => {
    navigate(chatPathForRoom(selectedRoomID));
  }, [chatPathForRoom, navigate, selectedRoomID]);

  return {
    handleLogout,
    handleOpenAdminModal,
    handleCopyInviteLinkWrapper,
    handleDeleteRoomWrapper,
    handleEnableNotificationsWrapper,
    handleToggleThemeMode,
    handleTogglePeerPanel,
    handleClosePeerPanel,
    handleEditMessageWrapper,
    handleCloseRoomModal,
    handleCreateRoomWrapper,
    handleJoinRoomWrapper,
    handleCloseAdminModal,
  };
}
