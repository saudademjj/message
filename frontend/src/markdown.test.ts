const { sanitizeMock } = vi.hoisted(() => ({
  sanitizeMock: vi.fn((html: string) =>
    html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/javascript:/gi, ''),
  ),
}));

vi.mock('dompurify', () => ({
  default: {
    sanitize: sanitizeMock,
  },
}));

import { renderMarkdownSafe } from './markdown';

describe('renderMarkdownSafe', () => {
  beforeEach(() => {
    sanitizeMock.mockClear();
  });

  it('sanitizes script and javascript protocols', () => {
    const html = renderMarkdownSafe('[x](javascript:alert(1))<script>alert(1)</script>');

    expect(sanitizeMock).toHaveBeenCalledTimes(1);
    expect(html.toLowerCase()).not.toContain('<script');
    expect(html.toLowerCase()).not.toContain('javascript:');
  });

  it('preserves emoji in rendered output', () => {
    const html = renderMarkdownSafe('hello 😀 world');
    expect(html).toContain('hello');
    expect(html).toContain('world');
    expect(html).toContain('😀');
  });

  it('uses cache for identical markdown input', () => {
    const input = '```ts\nconst n = 1\n```';
    const first = renderMarkdownSafe(input);
    const second = renderMarkdownSafe(input);

    expect(first).toBe(second);
    expect(sanitizeMock).toHaveBeenCalledTimes(1);
  });
});
