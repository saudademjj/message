import { useCallback, useEffect, useRef, useState } from 'react';

export type Toast = {
  id: number;
  kind: 'error' | 'info';
  text: string;
};

type ToastTimerMeta = {
  remainingMs: number;
  startedAtMs: number;
  paused: boolean;
};

export function useToasts(autoCloseMs = 4200) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastIDRef = useRef(1);
  const toastTimersRef = useRef<Map<number, number>>(new Map());
  const toastTimerMetaRef = useRef<Map<number, ToastTimerMeta>>(new Map());

  const dismissToast = useCallback((toastID: number) => {
    const timer = toastTimersRef.current.get(toastID);
    if (typeof timer === 'number') {
      window.clearTimeout(timer);
      toastTimersRef.current.delete(toastID);
    }
    toastTimerMetaRef.current.delete(toastID);
    setToasts((previous) => previous.filter((item) => item.id !== toastID));
  }, []);

  const scheduleToastDismissal = useCallback((toastID: number, delayMs: number) => {
    const normalizedDelay = Math.max(300, Math.floor(delayMs));
    const existing = toastTimersRef.current.get(toastID);
    if (typeof existing === 'number') {
      window.clearTimeout(existing);
    }
    const timeoutID = window.setTimeout(() => {
      dismissToast(toastID);
    }, normalizedDelay);
    toastTimersRef.current.set(toastID, timeoutID);
    toastTimerMetaRef.current.set(toastID, {
      remainingMs: normalizedDelay,
      startedAtMs: Date.now(),
      paused: false,
    });
  }, [dismissToast]);

  const pauseToastDismissal = useCallback((toastID: number) => {
    const meta = toastTimerMetaRef.current.get(toastID);
    if (!meta || meta.paused) {
      return;
    }
    const elapsed = Date.now() - meta.startedAtMs;
    meta.remainingMs = Math.max(120, meta.remainingMs - elapsed);
    meta.paused = true;
    toastTimerMetaRef.current.set(toastID, meta);
    const timer = toastTimersRef.current.get(toastID);
    if (typeof timer === 'number') {
      window.clearTimeout(timer);
      toastTimersRef.current.delete(toastID);
    }
  }, []);

  const resumeToastDismissal = useCallback((toastID: number) => {
    const meta = toastTimerMetaRef.current.get(toastID);
    if (!meta || !meta.paused) {
      return;
    }
    scheduleToastDismissal(toastID, meta.remainingMs);
  }, [scheduleToastDismissal]);

  const pushToast = useCallback((kind: Toast['kind'], text: string) => {
    const normalized = text.trim();
    if (!normalized) {
      return;
    }
    const toastID = toastIDRef.current;
    toastIDRef.current += 1;
    setToasts((previous) => [...previous, { id: toastID, kind, text: normalized }]);
    scheduleToastDismissal(toastID, autoCloseMs);
  }, [autoCloseMs, scheduleToastDismissal]);

  useEffect(() => {
    const timers = toastTimersRef.current;
    const meta = toastTimerMetaRef.current;
    return () => {
      for (const timer of timers.values()) {
        window.clearTimeout(timer);
      }
      timers.clear();
      meta.clear();
    };
  }, []);

  return {
    toasts,
    dismissToast,
    pauseToastDismissal,
    resumeToastDismissal,
    pushToast,
  };
}
