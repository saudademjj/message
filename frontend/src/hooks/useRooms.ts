import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { NavigateFunction } from 'react-router-dom';
import { ApiError, type ApiClient } from '../api';
import { INVITE_QUERY_KEY, clearInviteTokenFromLocation, extractInviteTokenFromInput, parseInviteTokenFromLocation } from '../app/helpers';
import { useChatStore } from '../stores/chatStore';
import type { Room } from '../types';
import type { AuthSession } from '../contexts/AuthContext';

type UseRoomsArgs = {
  api: ApiClient;
  auth: AuthSession | null;
  routeMode: 'chat' | 'admin';
  roomIDFromRoute: number | null;
  navigate: NavigateFunction;
  chatPathForRoom: (roomID: number | null) => string;
  reportError: (reason: unknown, fallback: string) => void;
  setBusy: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string>>;
  setInfo: Dispatch<SetStateAction<string>>;
  closeSidebar: () => void;
  onAuthReset?: () => void;
};

type UseRoomsResult = {
  rooms: Room[];
  selectedRoomID: number | null;
  selectedRoom: Room | null;
  roomMembers: { id: number; username: string; role: 'admin' | 'user' }[];
  setSelectedRoomID: (roomID: number | null | ((previous: number | null) => number | null)) => void;
  setRoomMembers: (
    next:
      | { id: number; username: string; role: 'admin' | 'user' }[]
      | ((previous: { id: number; username: string; role: 'admin' | 'user' }[]) => { id: number; username: string; role: 'admin' | 'user' }[]),
  ) => void;
  refreshRooms: (signal?: AbortSignal) => Promise<void>;
  filteredRooms: Room[];
  roomListQuery: string;
  setRoomListQuery: Dispatch<SetStateAction<string>>;
  roomModalOpen: boolean;
  setRoomModalOpen: Dispatch<SetStateAction<boolean>>;
  roomModalMode: 'create' | 'join';
  setRoomModalMode: Dispatch<SetStateAction<'create' | 'join'>>;
  openRoomModal: (mode: 'create' | 'join') => void;
  newRoomName: string;
  setNewRoomName: Dispatch<SetStateAction<string>>;
  joinRoomID: string;
  setJoinRoomID: Dispatch<SetStateAction<string>>;
  pendingInviteToken: string | null;
  handleCreateRoom: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  handleJoinRoom: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  handleCopyInviteLink: () => Promise<void>;
  handleDeleteRoom: () => Promise<void>;
};

export function useRooms({
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
}: UseRoomsArgs): UseRoomsResult {
  const rooms = useChatStore((state) => state.rooms);
  const setRooms = useChatStore((state) => state.setRooms);
  const roomMembers = useChatStore((state) => state.roomMembers);
  const setRoomMembers = useChatStore((state) => state.setRoomMembers);
  const selectedRoomID = useChatStore((state) => state.selectedRoomID);
  const setSelectedRoomID = useChatStore((state) => state.setSelectedRoomID);

  const [roomListQuery, setRoomListQuery] = useState('');
  const [roomModalOpen, setRoomModalOpen] = useState(false);
  const [roomModalMode, setRoomModalMode] = useState<'create' | 'join'>('create');
  const [newRoomName, setNewRoomName] = useState('');
  const [joinRoomID, setJoinRoomID] = useState('');
  const [pendingInviteToken, setPendingInviteToken] = useState<string | null>(parseInviteTokenFromLocation);
  const inviteJoiningRef = useRef(false);

  const selectedRoom = useMemo(
    () => rooms.find((room) => room.id === selectedRoomID) ?? null,
    [rooms, selectedRoomID],
  );

  const filteredRooms = useMemo(() => {
    const query = roomListQuery.trim().toLowerCase();
    if (!query) {
      return rooms;
    }
    return rooms.filter((room) =>
      room.name.toLowerCase().includes(query) || String(room.id).includes(query),
    );
  }, [roomListQuery, rooms]);

  const mapRoomActionError = useCallback((reason: unknown, fallback: string): string => {
    if (reason instanceof ApiError && reason.code === 'http') {
      if (reason.serverCode === 'room_name_conflict') {
        return '房间名已存在，请更换后再创建';
      }
      if (reason.serverCode === 'invite_required') {
        return '普通用户需要邀请链接才能加入房间';
      }
      if (reason.serverCode === 'system_room_admin_only') {
        return '系统房间仅管理员可邀请或加入';
      }
    }
    return fallback;
  }, []);

  const refreshRooms = useCallback(
    async (signal?: AbortSignal) => {
      const roomResult = await api.listRooms({ signal });
      setRooms(roomResult.rooms);
      setSelectedRoomID((previous) => {
        if (roomIDFromRoute && roomResult.rooms.some((room) => room.id === roomIDFromRoute)) {
          return roomIDFromRoute;
        }
        if (previous && roomResult.rooms.some((room) => room.id === previous)) {
          return previous;
        }
        return roomResult.rooms[0]?.id ?? null;
      });
    },
    [api, roomIDFromRoute, setRooms, setSelectedRoomID],
  );

  useEffect(() => {
    if (!auth) {
      setRooms([]);
      setRoomMembers([]);
      setSelectedRoomID(null);
      setRoomListQuery('');
      setRoomModalOpen(false);
      setRoomModalMode('create');
      setNewRoomName('');
      setJoinRoomID('');
      if (onAuthReset) {
        onAuthReset();
      }
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    setBusy(true);
    refreshRooms(controller.signal)
      .catch((reason: unknown) => {
        if (!cancelled) {
          reportError(reason, '无法加载房间列表');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setBusy(false);
        }
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [auth, onAuthReset, refreshRooms, reportError, setBusy, setRoomMembers, setRooms, setSelectedRoomID]);

  useEffect(() => {
    if (!auth || rooms.length === 0) {
      return;
    }
    if (routeMode === 'chat') {
      if (selectedRoomID && rooms.some((room) => room.id === selectedRoomID)) {
        if (roomIDFromRoute !== selectedRoomID) {
          navigate(`/chat/${selectedRoomID}`, { replace: true });
        }
        return;
      }
      if (roomIDFromRoute && rooms.some((room) => room.id === roomIDFromRoute)) {
        if (selectedRoomID !== roomIDFromRoute) {
          setSelectedRoomID(roomIDFromRoute);
        }
        return;
      }
      const fallbackRoomID = rooms[0]?.id ?? null;
      if (fallbackRoomID) {
        setSelectedRoomID(fallbackRoomID);
        navigate(`/chat/${fallbackRoomID}`, { replace: true });
      }
      return;
    }

    if (routeMode === 'admin' && !selectedRoomID) {
      const fallbackRoomID = rooms[0]?.id ?? null;
      if (fallbackRoomID) {
        setSelectedRoomID(fallbackRoomID);
      }
    }
  }, [
    auth,
    navigate,
    roomIDFromRoute,
    rooms,
    routeMode,
    selectedRoomID,
    setSelectedRoomID,
  ]);

  useEffect(() => {
    if (!auth || !pendingInviteToken || inviteJoiningRef.current) {
      return;
    }
    inviteJoiningRef.current = true;
    setBusy(true);
    setError('');
    api.joinRoomByInvite(pendingInviteToken)
      .then(async ({ room }) => {
        await refreshRooms();
        setSelectedRoomID(room.id);
        setInfo(`已通过邀请链接加入房间: #${room.id} ${room.name}`);
      })
      .catch((reason: unknown) => {
        reportError(reason, '邀请链接已失效或不可用');
      })
      .finally(() => {
        inviteJoiningRef.current = false;
        setPendingInviteToken(null);
        clearInviteTokenFromLocation();
        setBusy(false);
      });
  }, [api, auth, pendingInviteToken, refreshRooms, reportError, setBusy, setError, setInfo, setSelectedRoomID, inviteJoiningRef]);

  useEffect(() => {
    if (!auth || !selectedRoomID) {
      setRoomMembers([]);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    api.listRoomMembers(selectedRoomID, { signal: controller.signal })
      .then((result) => {
        if (!cancelled) {
          setRoomMembers(result.members);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled) {
          reportError(reason, '加载房间成员失败');
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [api, auth, selectedRoomID, reportError, setRoomMembers]);

  const openRoomModal = useCallback((mode: 'create' | 'join') => {
    setRoomModalMode(mode);
    setRoomModalOpen(true);
    closeSidebar();
  }, [closeSidebar]);

  const handleCreateRoom = useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!auth) {
      return;
    }
    const roomName = newRoomName.trim();
    if (!roomName) {
      return;
    }

    setError('');
    setBusy(true);
    try {
      const { room } = await api.createRoom(roomName);
      await refreshRooms();
      setSelectedRoomID(room.id);
      setNewRoomName('');
      closeSidebar();
      setRoomModalOpen(false);
      setInfo(`已创建并加入房间: ${room.name}`);
    } catch (reason: unknown) {
      reportError(reason, mapRoomActionError(reason, '创建房间失败'));
    } finally {
      setBusy(false);
    }
  }, [api, auth, closeSidebar, mapRoomActionError, newRoomName, refreshRooms, reportError, setBusy, setError, setInfo, setSelectedRoomID]);

  const handleJoinRoom = useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!auth) {
      return;
    }

    const input = joinRoomID.trim();
    if (!input) {
      setError('请输入邀请链接或邀请令牌');
      return;
    }

    const inviteToken = extractInviteTokenFromInput(input);
    const allowDirectJoin = auth.user.role === 'admin';
    let roomID: number | null = null;
    if (!inviteToken) {
      if (!allowDirectJoin) {
        setError('普通用户仅支持邀请加入，请粘贴邀请链接或邀请令牌');
        return;
      }
      if (!/^\d+$/.test(input)) {
        setError('请输入有效房间 ID 或邀请链接');
        return;
      }
      roomID = Number(input);
      if (!Number.isSafeInteger(roomID) || roomID <= 0) {
        setError('请输入有效房间 ID');
        return;
      }
    }

    setBusy(true);
    setError('');
    try {
      if (inviteToken) {
        const { room } = await api.joinRoomByInvite(inviteToken);
        await refreshRooms();
        setSelectedRoomID(room.id);
        setJoinRoomID('');
        closeSidebar();
        setRoomModalOpen(false);
        setInfo(`已通过邀请加入房间: #${room.id} ${room.name}`);
        return;
      }

      if (!roomID) {
        setError('请输入有效房间 ID');
        return;
      }

      await api.joinRoom(roomID);
      await refreshRooms();
      setSelectedRoomID(roomID);
      setJoinRoomID('');
      closeSidebar();
      setRoomModalOpen(false);
      setInfo(`已加入房间 #${roomID}`);
    } catch (reason: unknown) {
      reportError(reason, mapRoomActionError(reason, '加入房间失败'));
    } finally {
      setBusy(false);
    }
  }, [api, auth, closeSidebar, joinRoomID, mapRoomActionError, refreshRooms, reportError, setBusy, setError, setInfo, setSelectedRoomID]);

  const handleCopyInviteLink = useCallback(async () => {
    if (!auth || !selectedRoomID) {
      return;
    }
    setBusy(true);
    setError('');
    try {
      const { inviteToken, expiresAt } = await api.createRoomInvite(selectedRoomID);
      const inviteURL = new URL(window.location.href);
      inviteURL.searchParams.delete(INVITE_QUERY_KEY);
      const hash = inviteURL.hash.startsWith('#') ? inviteURL.hash.slice(1) : inviteURL.hash;
      const hashParams = new URLSearchParams(hash);
      hashParams.set(INVITE_QUERY_KEY, inviteToken);
      inviteURL.hash = hashParams.toString();
      const inviteText = inviteURL.toString();
      if (typeof navigator.clipboard?.writeText === 'function') {
        await navigator.clipboard.writeText(inviteText);
      } else {
        window.prompt('复制邀请链接', inviteText);
      }
      const expiresAtText = new Date(expiresAt).toLocaleString();
      setInfo(`邀请链接已复制（有效期至 ${expiresAtText}）`);
    } catch (reason: unknown) {
      reportError(reason, '生成邀请链接失败');
    } finally {
      setBusy(false);
    }
  }, [api, auth, selectedRoomID, reportError, setBusy, setError, setInfo]);

  const handleDeleteRoom = useCallback(async () => {
    if (!auth || !selectedRoom) {
      return;
    }

    const confirmed = window.confirm(`确认删除房间 #${selectedRoom.id} ${selectedRoom.name}？此操作不可恢复。`);
    if (!confirmed) {
      return;
    }

    setBusy(true);
    setError('');
    try {
      await api.deleteRoom(selectedRoom.id);
      await refreshRooms();
      setInfo(`已删除房间 #${selectedRoom.id}`);
      if (routeMode === 'admin') {
        navigate(chatPathForRoom(selectedRoomID), { replace: true });
      }
    } catch (reason: unknown) {
      reportError(reason, '删除房间失败');
    } finally {
      setBusy(false);
    }
  }, [api, auth, chatPathForRoom, navigate, refreshRooms, reportError, routeMode, selectedRoom, selectedRoomID, setBusy, setError, setInfo]);

  return {
    rooms,
    selectedRoomID,
    selectedRoom,
    roomMembers,
    setSelectedRoomID,
    setRoomMembers,
    refreshRooms,
    filteredRooms,
    roomListQuery,
    setRoomListQuery,
    roomModalOpen,
    setRoomModalOpen,
    roomModalMode,
    setRoomModalMode,
    openRoomModal,
    newRoomName,
    setNewRoomName,
    joinRoomID,
    setJoinRoomID,
    pendingInviteToken,
    handleCreateRoom,
    handleJoinRoom,
    handleCopyInviteLink,
    handleDeleteRoom,
  };
}
