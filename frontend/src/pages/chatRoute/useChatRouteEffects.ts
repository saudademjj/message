import { useEffect } from 'react';
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import type { AuthSession } from '../../contexts/AuthContext';
import type { QuoteReplyPayload } from '../../components/ChatTimeline';
import { persistThemeMode } from '../../app/helpers';
import { useFocusTrap } from '../../hooks/useFocusTrap';

type UseChatRouteEffectsArgs = {
  sidebarRef: RefObject<HTMLElement | null>;
  peerPopoverRef: RefObject<HTMLDivElement | null>;
  roomModalCardRef: RefObject<HTMLElement | null>;
  adminModalCardRef: RefObject<HTMLElement | null>;
  sidebarOpen: boolean;
  isMobileInputMode: boolean;
  peerPanelOpen: boolean;
  roomModalOpen: boolean;
  adminModalOpen: boolean;
  themeMode: 'light' | 'dark';
  error: string;
  info: string;
  pushToast: (kind: 'error' | 'info', message: string) => void;
  setError: Dispatch<SetStateAction<string>>;
  setInfo: Dispatch<SetStateAction<string>>;
  cryptoError: string;
  consumeCryptoError: () => void;
  cryptoInfo: string;
  consumeCryptoInfo: () => void;
  wsError: string;
  clearWsError: () => void;
  setNotificationPermission: Dispatch<SetStateAction<NotificationPermission>>;
  auth: AuthSession | null;
  routeMode: 'chat' | 'admin';
  navigate: NavigateFunction;
  chatPathForRoom: (roomID: number | null) => string;
  selectedRoomID: number | null;
  setAdminUserSearch: Dispatch<SetStateAction<string>>;
  setAdminPage: Dispatch<SetStateAction<number>>;
  setAdminModalOpen: Dispatch<SetStateAction<boolean>>;
  setRoomModalOpen: Dispatch<SetStateAction<boolean>>;
  setPeerPanelOpen: Dispatch<SetStateAction<boolean>>;
  closeSidebar: () => void;
  setIsMobileInputMode: Dispatch<SetStateAction<boolean>>;
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
  draftInputRef: MutableRefObject<HTMLTextAreaElement | null>;
  draft: string;
  replyTarget: QuoteReplyPayload | null;
};

export function useChatRouteEffects({
  sidebarRef,
  peerPopoverRef,
  roomModalCardRef,
  adminModalCardRef,
  sidebarOpen,
  isMobileInputMode,
  peerPanelOpen,
  roomModalOpen,
  adminModalOpen,
  themeMode,
  error,
  info,
  pushToast,
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
  selectedRoomID,
  setAdminUserSearch,
  setAdminPage,
  setAdminModalOpen,
  setRoomModalOpen,
  setPeerPanelOpen,
  closeSidebar,
  setIsMobileInputMode,
  setSidebarOpen,
  draftInputRef,
  draft,
  replyTarget,
}: UseChatRouteEffectsArgs) {
  useFocusTrap({
    containerRef: sidebarRef,
    active: sidebarOpen && isMobileInputMode,
  });

  useFocusTrap({
    containerRef: peerPopoverRef,
    active: peerPanelOpen,
  });

  useFocusTrap({
    containerRef: roomModalCardRef,
    active: roomModalOpen,
  });

  useFocusTrap({
    containerRef: adminModalCardRef,
    active: adminModalOpen,
  });

  useEffect(() => {
    persistThemeMode(themeMode);
  }, [themeMode]);

  useEffect(() => {
    if (!error) {
      return;
    }
    pushToast('error', error);
    setError('');
  }, [error, pushToast, setError]);

  useEffect(() => {
    if (!info) {
      return;
    }
    pushToast('info', info);
    setInfo('');
  }, [info, pushToast, setInfo]);

  useEffect(() => {
    if (!cryptoError) {
      return;
    }
    setError(cryptoError);
    consumeCryptoError();
  }, [consumeCryptoError, cryptoError, setError]);

  useEffect(() => {
    if (!cryptoInfo) {
      return;
    }
    setInfo(cryptoInfo);
    consumeCryptoInfo();
  }, [consumeCryptoInfo, cryptoInfo, setInfo]);

  useEffect(() => {
    if (!wsError) {
      return;
    }
    setError(wsError);
    clearWsError();
  }, [clearWsError, setError, wsError]);

  useEffect(() => {
    if (typeof Notification === 'undefined') {
      return;
    }
    const syncPermission = () => {
      setNotificationPermission(Notification.permission);
    };
    syncPermission();
    window.addEventListener('focus', syncPermission);
    document.addEventListener('visibilitychange', syncPermission);
    return () => {
      window.removeEventListener('focus', syncPermission);
      document.removeEventListener('visibilitychange', syncPermission);
    };
  }, [setNotificationPermission]);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      if (adminModalOpen) {
        navigate(chatPathForRoom(selectedRoomID));
        return;
      }
      if (roomModalOpen) {
        setRoomModalOpen(false);
        return;
      }
      if (peerPanelOpen) {
        setPeerPanelOpen(false);
        return;
      }
      if (sidebarOpen) {
        closeSidebar();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [
    adminModalOpen,
    chatPathForRoom,
    closeSidebar,
    navigate,
    peerPanelOpen,
    roomModalOpen,
    selectedRoomID,
    setPeerPanelOpen,
    setRoomModalOpen,
    sidebarOpen,
  ]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const media = window.matchMedia('(max-width: 900px), (pointer: coarse)');
    const syncMobileMode = () => {
      setIsMobileInputMode(media.matches);
    };
    syncMobileMode();
    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', syncMobileMode);
      return () => {
        media.removeEventListener('change', syncMobileMode);
      };
    }
    media.addListener(syncMobileMode);
    return () => {
      media.removeListener(syncMobileMode);
    };
  }, [setIsMobileInputMode]);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.visualViewport) {
      return;
    }
    const viewport = window.visualViewport;
    const root = document.documentElement;
    let prevOverlap = 0;
    const updateKeyboardOffset = () => {
      const overlap = Math.max(
        0,
        Math.round(window.innerHeight - (viewport.height + viewport.offsetTop)),
      );
      root.style.setProperty('--soft-keyboard-offset', `${overlap}px`);
      // Prevent page from scrolling out of viewport when keyboard opens
      if (overlap > 0) {
        root.classList.add('keyboard-open');
        window.scrollTo(0, 0);
      } else if (prevOverlap > 0) {
        root.classList.remove('keyboard-open');
      }
      prevOverlap = overlap;
    };
    updateKeyboardOffset();
    viewport.addEventListener('resize', updateKeyboardOffset);
    viewport.addEventListener('scroll', updateKeyboardOffset);
    window.addEventListener('orientationchange', updateKeyboardOffset);
    return () => {
      viewport.removeEventListener('resize', updateKeyboardOffset);
      viewport.removeEventListener('scroll', updateKeyboardOffset);
      window.removeEventListener('orientationchange', updateKeyboardOffset);
      root.style.setProperty('--soft-keyboard-offset', '0px');
      root.classList.remove('keyboard-open');
    };
  }, []);

  useEffect(() => {
    if (!isMobileInputMode) {
      return;
    }
    let startX = 0;
    let startY = 0;
    let tracking = false;
    let canOpen = false;
    let canClose = false;

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        tracking = false;
        return;
      }
      const touch = event.touches[0];
      startX = touch.clientX;
      startY = touch.clientY;
      canOpen = !sidebarOpen && startX <= 24;
      canClose = sidebarOpen && startX <= Math.min(window.innerWidth * 0.88, 360);
      tracking = canOpen || canClose;
    };

    const onTouchEnd = (event: TouchEvent) => {
      if (!tracking || event.changedTouches.length === 0) {
        return;
      }
      const touch = event.changedTouches[0];
      const deltaX = touch.clientX - startX;
      const deltaY = touch.clientY - startY;
      const horizontalSwipe =
        Math.abs(deltaX) > Math.abs(deltaY) * 1.2 && Math.abs(deltaY) < 90;
      if (!horizontalSwipe) {
        tracking = false;
        return;
      }
      if (canOpen && deltaX > 72) {
        setSidebarOpen(true);
      } else if (canClose && deltaX < -72) {
        closeSidebar();
      }
      tracking = false;
    };

    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchend', onTouchEnd, { passive: true });
    return () => {
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchend', onTouchEnd);
    };
  }, [closeSidebar, isMobileInputMode, setSidebarOpen, sidebarOpen]);

  useEffect(() => {
    if (!sidebarOpen || !window.matchMedia('(max-width: 900px)').matches) {
      return;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [sidebarOpen]);

  useEffect(() => {
    if (!roomModalOpen && !adminModalOpen) {
      return;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [adminModalOpen, roomModalOpen]);

  useEffect(() => {
    if (!auth) {
      navigate('/login', { replace: true });
    }
  }, [auth, navigate]);

  useEffect(() => {
    if (!auth) {
      return;
    }
    if (routeMode === 'admin') {
      if (auth.user.role !== 'admin') {
        navigate(chatPathForRoom(selectedRoomID), { replace: true });
        return;
      }
      if (!adminModalOpen) {
        setAdminUserSearch('');
        setAdminPage(1);
        setAdminModalOpen(true);
      }
      return;
    }
    if (adminModalOpen) {
      setAdminModalOpen(false);
    }
  }, [
    adminModalOpen,
    auth,
    chatPathForRoom,
    navigate,
    routeMode,
    selectedRoomID,
    setAdminModalOpen,
    setAdminPage,
    setAdminUserSearch,
  ]);

  useEffect(() => {
    if (!draftInputRef.current) {
      return;
    }
    draftInputRef.current.style.height = 'auto';
    const nextHeight = Math.min(170, draftInputRef.current.scrollHeight);
    draftInputRef.current.style.height = `${nextHeight}px`;
  }, [draft, draftInputRef, replyTarget]);
}
