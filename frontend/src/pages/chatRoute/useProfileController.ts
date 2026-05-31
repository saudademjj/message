import { useCallback, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { ApiClient } from '../../api';
import type { AuthSession } from '../../contexts/AuthContext';
import type { User } from '../../types';

type UseProfileControllerArgs = {
  api: ApiClient;
  auth: AuthSession | null;
  refreshSession: () => Promise<void>;
  updateAuthUser: (user: User) => void;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setInfo: Dispatch<SetStateAction<string>>;
  setError: Dispatch<SetStateAction<string>>;
  reportError: (reason: unknown, fallback: string) => void;
  // Invoked after a successful username change so the caller can propagate the
  // new name to the live room socket and room members (see ChatRoutePage).
  onProfileUpdated?: () => void;
};

export type ProfileController = ReturnType<typeof useProfileController>;

export function useProfileController({
  api,
  auth,
  refreshSession,
  updateAuthUser,
  setBusy,
  setInfo,
  setError,
  reportError,
  onProfileUpdated,
}: UseProfileControllerArgs) {
  const [profileModalOpen, setProfileModalOpen] = useState(false);

  const openProfileModal = useCallback(() => {
    setError('');
    setProfileModalOpen(true);
  }, [setError]);

  const closeProfileModal = useCallback(() => {
    setProfileModalOpen(false);
  }, []);

  const handleUpdateUsername = useCallback(async (username: string): Promise<boolean> => {
    if (!auth) {
      // No active session: nothing happened, so report failure to the modal so
      // it does not show success for a no-op.
      return false;
    }
    setBusy(true);
    try {
      const res = await api.updateProfile(username);
      updateAuthUser(res.user);
      await refreshSession();
      setInfo('用户名已更新');
      // Propagate the new username beyond the header/profile: the live room
      // socket caches the username on connect (backend), and stored
      // messages/members hold the old name until refreshed.
      onProfileUpdated?.();
      return true;
    } catch (reason: unknown) {
      reportError(reason, '更新用户名失败');
      // Rethrow so the modal can keep the form state open on failure.
      throw reason;
    } finally {
      setBusy(false);
    }
  }, [api, auth, refreshSession, reportError, setBusy, setInfo, updateAuthUser, onProfileUpdated]);

  const handleChangePassword = useCallback(async (current: string, next: string): Promise<boolean> => {
    if (!auth) {
      // No active session: treat as failure so the modal does not show success.
      return false;
    }
    setBusy(true);
    try {
      await api.changePassword(current, next);
      setInfo('密码已更新');
      return true;
    } catch (reason: unknown) {
      reportError(reason, '修改密码失败');
      // Rethrow so the modal can preserve the entered values on failure.
      throw reason;
    } finally {
      setBusy(false);
    }
  }, [api, auth, reportError, setBusy, setInfo]);

  return {
    profileModalOpen,
    openProfileModal,
    closeProfileModal,
    handleUpdateUsername,
    handleChangePassword,
  };
}
