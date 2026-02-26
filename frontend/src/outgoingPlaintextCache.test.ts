import {
  __resetOutgoingPlaintextCacheForTests,
  markOutgoingPlaintextDelivered,
  readOutgoingPlaintext,
  rememberOutgoingPlaintext,
} from './outgoingPlaintextCache';

describe('outgoingPlaintextCache', () => {
  beforeEach(async () => {
    await __resetOutgoingPlaintextCacheForTests({ clearPersistent: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await __resetOutgoingPlaintextCacheForTests({ clearPersistent: true });
  });

  it('returns cached plaintext for matching user-room-signature tuple', async () => {
    await rememberOutgoingPlaintext(101, 8, 'sig-101-8-a', 'hello world');

    await expect(readOutgoingPlaintext(101, 8, 'sig-101-8-a')).resolves.toBe('hello world');
  });

  it('isolates cache entries by signature, room and user', async () => {
    await rememberOutgoingPlaintext(101, 8, 'sig-101-8-b', 'message-a');

    await expect(readOutgoingPlaintext(101, 8, 'sig-101-8-c')).resolves.toBeNull();
    await expect(readOutgoingPlaintext(101, 9, 'sig-101-8-b')).resolves.toBeNull();
    await expect(readOutgoingPlaintext(102, 8, 'sig-101-8-b')).resolves.toBeNull();
  });

  it('expires entries after ttl window', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(2_000_000_000_000);
    await rememberOutgoingPlaintext(201, 9, 'sig-201-9-a', 'ttl-message');

    nowSpy.mockReturnValue(2_000_000_000_000 + 8 * 24 * 60 * 60 * 1000);

    await expect(readOutgoingPlaintext(201, 9, 'sig-201-9-a')).resolves.toBeNull();
  });

  it('evicts oldest entries when cache exceeds max capacity', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(2_100_000_000_000);

    for (let index = 0; index < 1210; index += 1) {
      await rememberOutgoingPlaintext(301, 10, `sig-301-10-${index}`, `payload-${index}`);
    }

    await expect(readOutgoingPlaintext(301, 10, 'sig-301-10-0')).resolves.toBeNull();
    await expect(readOutgoingPlaintext(301, 10, 'sig-301-10-1209')).resolves.toBe('payload-1209');
  });

  it('loads plaintext from indexeddb after memory reset', async () => {
    await rememberOutgoingPlaintext(401, 12, 'sig-401-12-a', 'persist-me');
    await __resetOutgoingPlaintextCacheForTests({ clearPersistent: false });

    await expect(readOutgoingPlaintext(401, 12, 'sig-401-12-a')).resolves.toBe('persist-me');
  });

  it('keeps plaintext readable after delivered marker is written', async () => {
    await rememberOutgoingPlaintext(501, 14, 'sig-501-14-a', 'bind-message-id');
    await markOutgoingPlaintextDelivered(501, 14, 'sig-501-14-a', 999);

    await expect(readOutgoingPlaintext(501, 14, 'sig-501-14-a')).resolves.toBe('bind-message-id');
  });
});
