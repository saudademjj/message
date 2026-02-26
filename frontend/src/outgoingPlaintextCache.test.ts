import { readOutgoingPlaintext, rememberOutgoingPlaintext } from './outgoingPlaintextCache';

describe('outgoingPlaintextCache', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns cached plaintext for matching user-room-signature tuple', () => {
    rememberOutgoingPlaintext(101, 8, 'sig-101-8-a', 'hello world');

    expect(readOutgoingPlaintext(101, 8, 'sig-101-8-a')).toBe('hello world');
  });

  it('isolates cache entries by signature, room and user', () => {
    rememberOutgoingPlaintext(101, 8, 'sig-101-8-b', 'message-a');

    expect(readOutgoingPlaintext(101, 8, 'sig-101-8-c')).toBeNull();
    expect(readOutgoingPlaintext(101, 9, 'sig-101-8-b')).toBeNull();
    expect(readOutgoingPlaintext(102, 8, 'sig-101-8-b')).toBeNull();
  });

  it('expires entries after ttl window', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(2_000_000_000_000);
    rememberOutgoingPlaintext(201, 9, 'sig-201-9-a', 'ttl-message');

    nowSpy.mockReturnValue(2_000_000_000_000 + 31 * 60 * 1000);

    expect(readOutgoingPlaintext(201, 9, 'sig-201-9-a')).toBeNull();
  });

  it('evicts oldest entries when cache exceeds max capacity', () => {
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(2_100_000_000_000);

    for (let index = 0; index < 410; index += 1) {
      rememberOutgoingPlaintext(301, 10, `sig-301-10-${index}`, `payload-${index}`);
    }

    expect(readOutgoingPlaintext(301, 10, 'sig-301-10-0')).toBeNull();
    expect(readOutgoingPlaintext(301, 10, 'sig-301-10-409')).toBe('payload-409');
  });
});
