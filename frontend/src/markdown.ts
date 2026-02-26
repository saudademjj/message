import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import go from 'highlight.js/lib/languages/go';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdownLang from 'highlight.js/lib/languages/markdown';
import typescript from 'highlight.js/lib/languages/typescript';
import { Marked, Renderer, type Tokens } from 'marked';

hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);
hljs.registerLanguage('go', go);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('markdown', markdownLang);
hljs.registerLanguage('md', markdownLang);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);

const marked = new Marked({
  breaks: true,
  async: false,
  gfm: true,
});

function escapeHTMLAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

const renderer = new Renderer();

renderer.code = ({ text, lang }: Tokens.Code): string => {
  const normalized = (lang ?? '').trim().toLowerCase();
  const highlighted = normalized && hljs.getLanguage(normalized)
    ? hljs.highlight(text, { language: normalized }).value
    : hljs.highlightAuto(text).value;
  const languageClass = normalized ? ` language-${escapeHTMLAttr(normalized)}` : '';
  return `<pre><code class="hljs${languageClass}">${highlighted}</code></pre>`;
};

renderer.link = ({ href, title, tokens }: Tokens.Link): string => {
  const text = tokens.map((token) => token.raw).join('');
  const safeHref = escapeHTMLAttr(href);
  const safeTitle = title ? ` title="${escapeHTMLAttr(title)}"` : '';
  return `<a href="${safeHref}"${safeTitle} target="_blank" rel="noopener noreferrer nofollow">${text}</a>`;
};

renderer.image = ({ href, title, text }: Tokens.Image): string => {
  const safeHref = escapeHTMLAttr(href);
  const safeAlt = escapeHTMLAttr(text);
  const safeTitle = title ? ` title="${escapeHTMLAttr(title)}"` : '';
  return `<img src="${safeHref}" alt="${safeAlt}" loading="lazy"${safeTitle} />`;
};

marked.use({ renderer });

const markdownCache = new Map<string, string>();
const MAX_CACHE = 180;

function cacheMarkdown(key: string, html: string): void {
  markdownCache.set(key, html);
  if (markdownCache.size > MAX_CACHE) {
    const first = markdownCache.keys().next();
    if (!first.done) {
      markdownCache.delete(first.value);
    }
  }
}

export function renderMarkdownSafe(text: string, highlightQuery?: string): string {
  const query = highlightQuery?.trim() ?? '';
  const cacheKey = query ? `${text}::highlight::${query}` : text;
  const cached = markdownCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const html = marked.parse(text) as string;
  let sanitized = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ALLOW_UNKNOWN_PROTOCOLS: false,
    FORBID_TAGS: ['style', 'script', 'iframe', 'object'],
    FORBID_ATTR: ['style', 'onerror', 'onclick', 'onload'],
  });

  if (query) {
    const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escapedQuery})`, 'gi');
    // Using a simple regex replace, being careful not to replace text inside HTML tags
    sanitized = sanitized.replace(/(>)([^<]*)(<)/g, (_match, p1, p2, p3) => {
      return p1 + p2.replace(regex, '<mark class="search-highlight">$1</mark>') + p3;
    });
  }

  cacheMarkdown(cacheKey, sanitized);
  return sanitized;
}
