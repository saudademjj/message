/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  loadOrCreateIdentityForDevice,
  rotateIdentityIfNeeded,
  type Identity,
} from '../crypto';
import { useAuth } from './AuthContext';

type CryptoContextValue = {
  identity: Identity | null;
  handshakeTick: number;
  bumpHandshakeTick: () => void;
  cryptoError: string;
  cryptoInfo: string;
  consumeCryptoError: () => void;
  consumeCryptoInfo: () => void;
};

const CryptoContext = createContext<CryptoContextValue | null>(null);

const IDENTITY_ROTATE_MINUTES = Number(import.meta.env.VITE_IDENTITY_ROTATE_MINUTES ?? '240');
const IDENTITY_KEY_HISTORY = Number(import.meta.env.VITE_IDENTITY_KEY_HISTORY ?? '6');
const IDENTITY_ROTATE_CHECK_INTERVAL_MS = 60 * 1000;

function formatCryptoError(reason: unknown, fallback: string): string {
  if (reason instanceof Error && reason.message.trim()) {
    return reason.message.trim();
  }
  return fallback;
}

type CryptoProviderProps = {
  children: ReactNode;
};

export function CryptoProvider({ children }: CryptoProviderProps) {
  const { auth } = useAuth();
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [handshakeTick, setHandshakeTick] = useState(0);
  const [cryptoError, setCryptoError] = useState('');
  const [cryptoInfo, setCryptoInfo] = useState('');

  useEffect(() => {
    if (!auth) {
      return;
    }

    let cancelled = false;
    const INIT_TIMEOUT_MS = 10_000;
    const MAX_RETRIES = 2;

    const initWithTimeout = (): Promise<Identity> => {
      return Promise.race([
        loadOrCreateIdentityForDevice(auth.user.id, auth.device.deviceId),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('密钥初始化超时 (10s)，请刷新页面重试')), INIT_TIMEOUT_MS),
        ),
      ]);
    };

    const attemptInit = async (attempt: number): Promise<void> => {
      try {
        const next = await initWithTimeout();
        if (!cancelled) {
          setIdentity(next);
        }
      } catch (reason: unknown) {
        if (cancelled) return;
        if (attempt < MAX_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          if (!cancelled) {
            await attemptInit(attempt + 1);
          }
        } else {
          setCryptoError(formatCryptoError(reason, '无法初始化端侧密钥对'));
        }
      }
    };

    void attemptInit(0);

    return () => {
      cancelled = true;
    };
  }, [auth]);

  useEffect(() => {
    if (!auth) {
      return;
    }

    let cancelled = false;
    const rotationAgeMs = Number.isFinite(IDENTITY_ROTATE_MINUTES) && IDENTITY_ROTATE_MINUTES > 0
      ? Math.floor(IDENTITY_ROTATE_MINUTES * 60 * 1000)
      : 4 * 60 * 60 * 1000;
    const historyLimit = Number.isFinite(IDENTITY_KEY_HISTORY) && IDENTITY_KEY_HISTORY > 0
      ? Math.floor(IDENTITY_KEY_HISTORY)
      : 6;

    const rotateIfNeeded = async () => {
      try {
        const { identity: nextIdentity, rotated } = await rotateIdentityIfNeeded(
          auth.user.id,
          auth.device.deviceId,
          rotationAgeMs,
          historyLimit,
        );
        if (!cancelled && rotated) {
          setIdentity(nextIdentity);
          setCryptoInfo('端侧密钥已轮换，前向安全性已增强');
        }
      } catch (reason: unknown) {
        if (!cancelled) {
          setCryptoError(formatCryptoError(reason, '端侧密钥轮换失败'));
        }
      }
    };

    void rotateIfNeeded();
    const timer = window.setInterval(() => {
      void rotateIfNeeded();
    }, IDENTITY_ROTATE_CHECK_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [auth]);

  const bumpHandshakeTick = useCallback(() => {
    setHandshakeTick((previous) => previous + 1);
  }, []);

  const consumeCryptoError = useCallback(() => {
    setCryptoError('');
  }, []);

  const consumeCryptoInfo = useCallback(() => {
    setCryptoInfo('');
  }, []);

  const activeIdentity = auth ? identity : null;

  const value = useMemo<CryptoContextValue>(() => ({
    identity: activeIdentity,
    handshakeTick,
    bumpHandshakeTick,
    cryptoError,
    cryptoInfo,
    consumeCryptoError,
    consumeCryptoInfo,
  }), [
    activeIdentity,
    handshakeTick,
    bumpHandshakeTick,
    cryptoError,
    cryptoInfo,
    consumeCryptoError,
    consumeCryptoInfo,
  ]);

  return <CryptoContext.Provider value={value}>{children}</CryptoContext.Provider>;
}

export function useCryptoContext(): CryptoContextValue {
  const value = useContext(CryptoContext);
  if (!value) {
    throw new Error('useCryptoContext must be used within CryptoProvider');
  }
  return value;
}
