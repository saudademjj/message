import { create } from 'zustand';
import type { SendQueueItem, UIMessage } from '../app/appTypes';
import type { Peer, Room, User } from '../types';

type ValueOrUpdater<T> = T | ((previous: T) => T);

type ChatStore = {
  rooms: Room[];
  roomMembers: User[];
  selectedRoomID: number | null;
  messages: UIMessage[];
  messageReadReceipts: Record<number, number[]>;
  peers: Record<number, Peer>;
  sendQueue: SendQueueItem[];
  managedUsers: User[];
  setRooms: (next: ValueOrUpdater<Room[]>) => void;
  setRoomMembers: (next: ValueOrUpdater<User[]>) => void;
  setSelectedRoomID: (next: ValueOrUpdater<number | null>) => void;
  setMessages: (next: ValueOrUpdater<UIMessage[]>) => void;
  setMessageReadReceipts: (next: ValueOrUpdater<Record<number, number[]>>) => void;
  setPeers: (next: ValueOrUpdater<Record<number, Peer>>) => void;
  setSendQueue: (next: ValueOrUpdater<SendQueueItem[]>) => void;
  setManagedUsers: (next: ValueOrUpdater<User[]>) => void;
  resetSessionScopedState: () => void;
};

function resolveValue<T>(next: ValueOrUpdater<T>, previous: T): T {
  if (typeof next === 'function') {
    return (next as (prev: T) => T)(previous);
  }
  return next;
}

export const useChatStore = create<ChatStore>((set) => ({
  rooms: [],
  roomMembers: [],
  selectedRoomID: null,
  messages: [],
  messageReadReceipts: {},
  peers: {},
  sendQueue: [],
  managedUsers: [],
  setRooms: (next) => {
    set((state) => ({ rooms: resolveValue(next, state.rooms) }));
  },
  setRoomMembers: (next) => {
    set((state) => ({ roomMembers: resolveValue(next, state.roomMembers) }));
  },
  setSelectedRoomID: (next) => {
    set((state) => ({ selectedRoomID: resolveValue(next, state.selectedRoomID) }));
  },
  setMessages: (next) => {
    set((state) => ({ messages: resolveValue(next, state.messages) }));
  },
  setMessageReadReceipts: (next) => {
    set((state) => ({ messageReadReceipts: resolveValue(next, state.messageReadReceipts) }));
  },
  setPeers: (next) => {
    set((state) => ({ peers: resolveValue(next, state.peers) }));
  },
  setSendQueue: (next) => {
    set((state) => ({ sendQueue: resolveValue(next, state.sendQueue) }));
  },
  setManagedUsers: (next) => {
    set((state) => ({ managedUsers: resolveValue(next, state.managedUsers) }));
  },
  resetSessionScopedState: () => {
    set({
      rooms: [],
      roomMembers: [],
      selectedRoomID: null,
      messages: [],
      messageReadReceipts: {},
      peers: {},
      sendQueue: [],
      managedUsers: [],
    });
  },
}));
