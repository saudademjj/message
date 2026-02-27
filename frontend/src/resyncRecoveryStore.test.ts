import {
  __resetResyncRecoveryStoreForTests,
  clearResyncRequest,
  rememberResyncRequest,
  shouldCooldownResyncRequest,
} from './resyncRecoveryStore';

describe('resyncRecoveryStore', () => {
  beforeEach(() => {
    __resetResyncRecoveryStoreForTests();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    __resetResyncRecoveryStoreForTests();
    vi.restoreAllMocks();
  });

  it('enforces cooldown for duplicate requests', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(2_000_000_000_000);

    rememberResyncRequest(100, 7, 200, 300);
    expect(shouldCooldownResyncRequest(100, 7, 200, 300)).toBe(true);

    nowSpy.mockReturnValue(2_000_000_000_000 + 3 * 60 * 1000);
    expect(shouldCooldownResyncRequest(100, 7, 200, 300)).toBe(false);
  });

  it('clears request cooldown explicitly', () => {
    rememberResyncRequest(101, 8, 201, 301);
    expect(shouldCooldownResyncRequest(101, 8, 201, 301)).toBe(true);

    clearResyncRequest(101, 8, 201, 301);
    expect(shouldCooldownResyncRequest(101, 8, 201, 301)).toBe(false);
  });

  it('drops cooldown entries when reset is requested', () => {
    rememberResyncRequest(102, 9, 202, 302);
    __resetResyncRecoveryStoreForTests();

    expect(shouldCooldownResyncRequest(102, 9, 202, 302)).toBe(false);
  });
});
