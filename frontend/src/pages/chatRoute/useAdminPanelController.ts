import { useCallback, useEffect, useMemo } from 'react';
import type { Dispatch, FormEvent, SetStateAction } from 'react';
import type { ApiClient } from '../../api';
import type { AuthSession } from '../../contexts/AuthContext';
import type { User } from '../../types';
import { ADMIN_PAGE_SIZE } from './constants';

type UseAdminPanelControllerArgs = {
  api: ApiClient;
  auth: AuthSession | null;
  managedUsers: User[];
  setManagedUsers: (users: User[]) => void;
  setAdminModalOpen: Dispatch<SetStateAction<boolean>>;
  adminUserSearch: string;
  setAdminUserSearch: Dispatch<SetStateAction<string>>;
  adminPage: number;
  setAdminPage: Dispatch<SetStateAction<number>>;
  newManagedUsername: string;
  setNewManagedUsername: Dispatch<SetStateAction<string>>;
  newManagedPassword: string;
  setNewManagedPassword: Dispatch<SetStateAction<string>>;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string>>;
  setInfo: Dispatch<SetStateAction<string>>;
  reportError: (reason: unknown, fallback: string) => void;
};

export function useAdminPanelController({
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
}: UseAdminPanelControllerArgs) {
  const filteredManagedUsers = useMemo(() => {
    const query = adminUserSearch.trim().toLowerCase();
    if (!query) {
      return managedUsers;
    }
    return managedUsers.filter((user) =>
      user.username.toLowerCase().includes(query) ||
      String(user.id).includes(query) ||
      user.role.toLowerCase().includes(query),
    );
  }, [adminUserSearch, managedUsers]);

  const adminPageCount = Math.max(1, Math.ceil(filteredManagedUsers.length / ADMIN_PAGE_SIZE));

  const pagedManagedUsers = useMemo(() => {
    const safePage = Math.max(1, Math.min(adminPage, adminPageCount));
    const start = (safePage - 1) * ADMIN_PAGE_SIZE;
    return filteredManagedUsers.slice(start, start + ADMIN_PAGE_SIZE);
  }, [adminPage, adminPageCount, filteredManagedUsers]);

  useEffect(() => {
    setAdminPage((previous) => Math.min(previous, adminPageCount));
  }, [adminPageCount, setAdminPage]);

  useEffect(() => {
    if (!auth || auth.user.role !== 'admin') {
      setManagedUsers([]);
      setAdminModalOpen(false);
      setAdminUserSearch('');
      setAdminPage(1);
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    api.listUsers({ signal: controller.signal })
      .then((result) => {
        if (!cancelled) {
          setManagedUsers(result.users);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          reportError(reason, '加载用户列表失败');
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [api, auth, reportError, setAdminModalOpen, setAdminPage, setAdminUserSearch, setManagedUsers]);

  const refreshManagedUsers = useCallback(async () => {
    if (!auth || auth.user.role !== 'admin') {
      return;
    }
    const result = await api.listUsers();
    setManagedUsers(result.users);
  }, [api, auth, setManagedUsers]);

  const handleCreateManagedUser = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!auth || auth.user.role !== 'admin') {
      return;
    }

    const targetUsername = newManagedUsername.trim();
    if (!targetUsername) {
      return;
    }

    setBusy(true);
    setError('');
    try {
      await api.createUser(targetUsername, newManagedPassword);
      await refreshManagedUsers();
      setNewManagedUsername('');
      setNewManagedPassword('');
      setInfo(`用户已创建: ${targetUsername}`);
    } catch (reason: unknown) {
      reportError(reason, '创建用户失败');
    } finally {
      setBusy(false);
    }
  }, [
    api,
    auth,
    newManagedPassword,
    newManagedUsername,
    refreshManagedUsers,
    reportError,
    setBusy,
    setError,
    setInfo,
    setNewManagedPassword,
    setNewManagedUsername,
  ]);

  const handleDeleteManagedUser = useCallback(async (user: User) => {
    if (!auth || auth.user.role !== 'admin') {
      return;
    }
    if (user.role === 'admin' || user.id === auth.user.id) {
      setError('管理员账号不可删除');
      return;
    }

    const confirmed = window.confirm(`确认删除用户 #${user.id} ${user.username}？相关房间成员关系与消息将被级联删除。`);
    if (!confirmed) {
      return;
    }

    setBusy(true);
    setError('');
    try {
      await api.deleteUser(user.id);
      await refreshManagedUsers();
      setInfo(`用户已删除: ${user.username}`);
    } catch (reason: unknown) {
      reportError(reason, '删除用户失败');
    } finally {
      setBusy(false);
    }
  }, [api, auth, refreshManagedUsers, reportError, setBusy, setError, setInfo]);

  const handleDeleteManagedUserWrapper = useCallback((user: User) => {
    void handleDeleteManagedUser(user);
  }, [handleDeleteManagedUser]);

  const handlePrevPage = useCallback(() => {
    setAdminPage((previous) => Math.max(1, previous - 1));
  }, [setAdminPage]);

  const handleNextPage = useCallback(() => {
    setAdminPage((previous) => Math.min(adminPageCount, previous + 1));
  }, [adminPageCount, setAdminPage]);

  const handleResetPage = useCallback(() => {
    setAdminPage(1);
  }, [setAdminPage]);

  return {
    filteredManagedUsers,
    adminPageCount,
    pagedManagedUsers,
    handleCreateManagedUser,
    handleDeleteManagedUser,
    handleDeleteManagedUserWrapper,
    handlePrevPage,
    handleNextPage,
    handleResetPage,
  };
}
