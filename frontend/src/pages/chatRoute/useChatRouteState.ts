import { useCallback, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { formatError, getInitialThemeMode, isMobileInputPreferred } from '../../app/helpers';
import type { ThemeMode } from '../../app/appTypes';
import type { QuoteReplyPayload } from '../../components/ChatTimeline';
import { useToasts } from '../../hooks/useToasts';
import type { User } from '../../types';

type UseChatRouteStateParams = {
  setManagedUsers: (users: User[]) => void;
};

export type ChatRouteState = ReturnType<typeof useChatRouteState>;

export function useChatRouteState({ setManagedUsers }: UseChatRouteStateParams) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [peerPanelOpen, setPeerPanelOpen] = useState(false);
  const [adminModalOpen, setAdminModalOpen] = useState(false);
  const [adminUserSearch, setAdminUserSearch] = useState('');
  const [adminPage, setAdminPage] = useState(1);
  const [newManagedUsername, setNewManagedUsername] = useState('');
  const [newManagedPassword, setNewManagedPassword] = useState('');
  const [draft, setDraft] = useState('');
  const [replyTarget, setReplyTarget] = useState<QuoteReplyPayload | null>(null);
  const [isMobileInputMode, setIsMobileInputMode] = useState(isMobileInputPreferred);
  const [themeMode, setThemeMode] = useState<ThemeMode>(getInitialThemeMode);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>(
    typeof Notification === 'undefined' ? 'denied' : Notification.permission,
  );

  const { toasts, dismissToast, pauseToastDismissal, resumeToastDismissal, pushToast } = useToasts();

  const sidebarRef = useRef<HTMLElement | null>(null);
  const peerPopoverRef = useRef<HTMLDivElement | null>(null);
  const roomModalCardRef = useRef<HTMLElement | null>(null);
  const adminModalCardRef = useRef<HTMLElement | null>(null);
  const draftInputRef = useRef<HTMLTextAreaElement | null>(null);
  const typingIdleTimerRef = useRef<number | null>(null);

  const chatPathForRoom = useCallback((roomID: number | null): string => {
    if (typeof roomID === 'number' && Number.isFinite(roomID) && roomID > 0) {
      return `/chat/${roomID}`;
    }
    return '/chat';
  }, []);

  const closeSidebar = useCallback(() => {
    setSidebarOpen(false);
  }, []);

  const toggleSidebar = useCallback(() => {
    setSidebarOpen((previous) => !previous);
  }, []);

  const reportError = useCallback((reason: unknown, fallback: string) => {
    const message = formatError(reason, fallback);
    if (message) {
      setError(message);
    }
  }, []);

  const onAuthReset = useCallback(() => {
    setAdminModalOpen(false);
    setAdminUserSearch('');
    setAdminPage(1);
    setPeerPanelOpen(false);
    setReplyTarget(null);
    setDraft('');
    setNewManagedUsername('');
    setNewManagedPassword('');
    setSidebarOpen(false);
    setManagedUsers([]);
  }, [setManagedUsers]);

  return {
    busy,
    setBusy,
    error,
    setError,
    info,
    setInfo,
    sidebarOpen,
    setSidebarOpen,
    peerPanelOpen,
    setPeerPanelOpen,
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
    isMobileInputMode,
    setIsMobileInputMode,
    themeMode,
    setThemeMode,
    notificationPermission,
    setNotificationPermission,
    toasts,
    dismissToast,
    pauseToastDismissal,
    resumeToastDismissal,
    pushToast,
    sidebarRef,
    peerPopoverRef,
    roomModalCardRef,
    adminModalCardRef,
    draftInputRef,
    typingIdleTimerRef,
    chatPathForRoom,
    closeSidebar,
    toggleSidebar,
    reportError,
    onAuthReset,
  };
}

export type SetState<T> = Dispatch<SetStateAction<T>>;
