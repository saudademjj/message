import { useChatStore } from './chatStore';

describe('chatStore', () => {
  beforeEach(() => {
    useChatStore.getState().resetSessionScopedState();
  });

  it('updates state via setters and updater functions', () => {
    useChatStore.getState().setRooms([{ id: 1, name: 'alpha', createdAt: '2026-01-01T00:00:00Z' }]);
    useChatStore.getState().setSelectedRoomID(1);
    useChatStore.getState().setSendQueue([{ id: 'q1', text: 'hello', status: 'queued', attempts: 0, lastError: null, createdAt: 1 }]);

    useChatStore.getState().setSendQueue((previous) => previous.map((item) => ({ ...item, status: 'failed' })));

    const state = useChatStore.getState();
    expect(state.rooms).toHaveLength(1);
    expect(state.selectedRoomID).toBe(1);
    expect(state.sendQueue[0]?.status).toBe('failed');
  });

  it('resets session-scoped state', () => {
    useChatStore.getState().setRooms([{ id: 1, name: 'alpha', createdAt: '2026-01-01T00:00:00Z' }]);
    useChatStore.getState().setManagedUsers([{ id: 3, username: 'alice', role: 'user' }]);

    useChatStore.getState().resetSessionScopedState();

    const state = useChatStore.getState();
    expect(state.rooms).toEqual([]);
    expect(state.managedUsers).toEqual([]);
    expect(state.selectedRoomID).toBeNull();
    expect(state.messages).toEqual([]);
  });
});
