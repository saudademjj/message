import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError } from '../api';
import { formatError, parseInviteTokenFromLocation } from '../app/helpers';
import { ToastLayer } from '../components/ToastLayer';
import { useAuth } from '../contexts/AuthContext';
import { useToasts } from '../hooks/useToasts';
import { LoginPage } from './LoginPage';

export function LoginRoutePage() {
  const navigate = useNavigate();
  const { auth, login } = useAuth();

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [hasPendingInvite, setHasPendingInvite] = useState(Boolean(parseInviteTokenFromLocation()));
  const { toasts, dismissToast, pauseToastDismissal, resumeToastDismissal, pushToast } = useToasts();

  useEffect(() => {
    const syncInviteState = () => {
      setHasPendingInvite(Boolean(parseInviteTokenFromLocation()));
    };
    syncInviteState();
    window.addEventListener('hashchange', syncInviteState);
    window.addEventListener('popstate', syncInviteState);
    return () => {
      window.removeEventListener('hashchange', syncInviteState);
      window.removeEventListener('popstate', syncInviteState);
    };
  }, []);

  useEffect(() => {
    if (auth) {
      navigate('/chat', { replace: true });
    }
  }, [auth, navigate]);

  useEffect(() => {
    if (!error) {
      return;
    }
    pushToast('error', error);
    setError('');
  }, [error, pushToast]);

  useEffect(() => {
    if (!info) {
      return;
    }
    pushToast('info', info);
    setInfo('');
  }, [info, pushToast]);

  const handleAuthSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError('');
    setInfo('');
    setBusy(true);
    try {
      await login(username.trim(), password);
      setUsername('');
      setPassword('');
      setInfo('登录成功');
    } catch (reason: unknown) {
      if (reason instanceof ApiError && reason.code === 'http' && reason.status === 401) {
        const normalized = reason.message.trim().toLowerCase();
        setError(
          normalized.includes('invalid credentials')
            ? '用户名或密码错误'
            : '登录状态已失效，请重新登录',
        );
      } else {
        setError(formatError(reason, '认证失败') ?? '认证失败');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <LoginPage
        username={username}
        password={password}
        busy={busy}
        hasPendingInvite={hasPendingInvite}
        onSubmit={handleAuthSubmit}
        onUsernameChange={setUsername}
        onPasswordChange={setPassword}
      />
      <ToastLayer
        toasts={toasts}
        onPause={pauseToastDismissal}
        onResume={resumeToastDismissal}
        onDismiss={dismissToast}
      />
    </>
  );
}
