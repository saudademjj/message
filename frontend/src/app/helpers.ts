import { ApiError, isApiAbortError } from '../api';
import type { DecryptRecoveryRequestFrame } from '../types';
import type { ThemeMode } from './appTypes';

export const INVITE_QUERY_KEY = 'invite';
const THEME_STORAGE_KEY = 'e2ee-chat.theme';
const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

// Regex matching common emoji ranges (Unicode emoji, dingbats, symbols, etc.)
// eslint-disable-next-line no-misleading-character-class
const EMOJI_REGEX = /[\p{Emoji_Presentation}\p{Extended_Pictographic}\u{200D}\u{FE0F}\u{20E3}\u{E0020}-\u{E007F}]/gu;

export function stripEmoji(text: string): string {
  return text.replace(EMOJI_REGEX, '');
}

const AVATAR_BACKGROUNDS = [
  'linear-gradient(140deg, #0f6dff, #1fc6e3)',
  'linear-gradient(140deg, #ff6b35, #ffae42)',
  'linear-gradient(140deg, #0fae8e, #49d6a4)',
  'linear-gradient(140deg, #dc2f8f, #ff7b9c)',
  'linear-gradient(140deg, #5140ff, #7c79ff)',
  'linear-gradient(140deg, #1b2a41, #32567a)',
];

export function getInitialThemeMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') {
      return stored;
    }
  } catch {
    // Ignore storage read errors.
  }
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return 'light';
}

export function persistThemeMode(themeMode: ThemeMode): void {
  const root = document.documentElement;
  root.dataset.theme = themeMode;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, themeMode);
  } catch {
    // Ignore storage write errors.
  }
}

export function createQueueItemID(): string {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `q-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

export function formatError(reason: unknown, fallback: string): string | null {
  if (isApiAbortError(reason)) {
    return null;
  }

  if (reason instanceof ApiError) {
    if (reason.code === 'timeout') {
      return '网络请求超时，请稍后重试';
    }
    if (reason.code === 'network') {
      return '网络连接异常，请检查网络后重试';
    }
    if (reason.code === 'http') {
      if (reason.status === 401) {
        const normalized = reason.message.trim().toLowerCase();
        if (normalized.includes('invalid credentials')) {
          return '用户名或密码错误';
        }
        if (
          normalized.includes('invalid token') ||
          normalized.includes('missing bearer token') ||
          normalized.includes('authorization required') ||
          normalized.includes('token role mismatch')
        ) {
          return '登录状态已失效，请重新登录';
        }
        return reason.message || fallback;
      }
      if (reason.status === 403) {
        return '无权限执行该操作';
      }
      if (reason.status === 404) {
        return '请求的资源不存在';
      }
      if (reason.status !== null && reason.status >= 500) {
        return '服务暂时不可用，请稍后重试';
      }
      return reason.message || fallback;
    }
  }

  if (reason instanceof Error) {
    const message = reason.message.trim();
    if (!message) {
      return fallback;
    }
    if (message.includes('WebSocket 未连接')) {
      return '连接未建立，消息已进入重试队列';
    }
    if (message.includes('double-ratchet session is not ready')) {
      return '安全通道尚未就绪，请稍后重试';
    }
    if (message.includes('Web Crypto requires HTTPS secure context')) {
      return '请通过 HTTPS 访问以启用端到端加密';
    }
    return message;
  }

  return fallback;
}

export function summarizeDraft(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '(空消息)';
  }
  return normalized.length > 42 ? `${normalized.slice(0, 42)}...` : normalized;
}

export function parseInviteTokenFromLocation(): string | null {
  const current = new URL(window.location.href);
  const searchToken = current.searchParams.get(INVITE_QUERY_KEY)?.trim();
  if (searchToken) {
    return searchToken;
  }
  const hash = current.hash.startsWith('#') ? current.hash.slice(1) : current.hash;
  const hashToken = new URLSearchParams(hash).get(INVITE_QUERY_KEY)?.trim();
  return hashToken || null;
}

function normalizeInviteToken(candidate: string | null | undefined): string | null {
  if (!candidate) {
    return null;
  }
  const trimmed = candidate.trim();
  if (!trimmed) {
    return null;
  }
  let decoded = trimmed;
  try {
    decoded = decodeURIComponent(trimmed).trim();
  } catch {
    decoded = trimmed;
  }
  if (!decoded || !INVITE_TOKEN_PATTERN.test(decoded)) {
    return null;
  }
  return decoded;
}

export function extractInviteTokenFromInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  const direct = normalizeInviteToken(trimmed);
  if (direct) {
    return direct;
  }

  const queryMatch = trimmed.match(/(?:[?#&]|^)invite=([^&#\s]+)/i);
  if (queryMatch?.[1]) {
    const matched = normalizeInviteToken(queryMatch[1]);
    if (matched) {
      return matched;
    }
  }

  const urlCandidates = [trimmed];
  if (!/^[a-z][a-z\d+\-.]*:\/\//i.test(trimmed) && /[/?#=]/.test(trimmed)) {
    urlCandidates.push(`https://${trimmed}`);
  }

  for (const candidate of urlCandidates) {
    try {
      const parsed = new URL(candidate);
      const searchToken = normalizeInviteToken(parsed.searchParams.get(INVITE_QUERY_KEY));
      if (searchToken) {
        return searchToken;
      }
      const hash = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash;
      if (hash) {
        const hashToken = normalizeInviteToken(new URLSearchParams(hash).get(INVITE_QUERY_KEY));
        if (hashToken) {
          return hashToken;
        }
      }
    } catch {
      // Ignore malformed URL input and continue.
    }
  }

  return null;
}

export function buildRecoveryRequestKey(
  request: Pick<DecryptRecoveryRequestFrame, 'roomId' | 'fromUserId' | 'messageId' | 'fromDeviceId'>,
): string {
  const fromDeviceID = typeof request.fromDeviceId === 'string'
    ? request.fromDeviceId.trim()
    : '';
  return `${request.roomId}:${request.fromUserId}:${request.messageId}:${fromDeviceID || '*'}`;
}

export function clearInviteTokenFromLocation(): void {
  const current = new URL(window.location.href);
  current.searchParams.delete(INVITE_QUERY_KEY);
  const hash = current.hash.startsWith('#') ? current.hash.slice(1) : current.hash;
  if (hash) {
    const hashParams = new URLSearchParams(hash);
    hashParams.delete(INVITE_QUERY_KEY);
    const nextHash = hashParams.toString();
    current.hash = nextHash ? `#${nextHash}` : '';
  } else {
    current.hash = '';
  }
  const replacement = `${current.pathname}${current.search}${current.hash}`;
  window.history.replaceState({}, '', replacement);
}

export function isMobileInputPreferred(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(max-width: 900px), (pointer: coarse)').matches;
}

export function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) {
    return timestamp;
  }
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function avatarGlyph(username: string): string {
  const trimmed = username.trim();
  return trimmed ? trimmed.slice(0, 1).toUpperCase() : '?';
}

export function avatarBackground(seed: number): string {
  const index = Math.abs(seed) % AVATAR_BACKGROUNDS.length;
  return AVATAR_BACKGROUNDS[index];
}

export function estimatePendingWidth(ciphertext: string): number {
  return Math.max(110, Math.min(380, 72 + Math.floor(ciphertext.length * 0.28)));
}

export function toLocalDateParts(timestamp: string): { key: string; value: Date } | null {
  const value = new Date(timestamp);
  if (Number.isNaN(value.getTime())) {
    return null;
  }
  const key = `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  return { key, value };
}

function dayStart(value: Date): number {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
}

export function formatTimelineLabel(timestamp: string): string {
  const parsed = toLocalDateParts(timestamp);
  if (!parsed) {
    return timestamp;
  }
  const now = new Date();
  const delta = Math.round((dayStart(now) - dayStart(parsed.value)) / (24 * 60 * 60 * 1000));
  if (delta === 0) {
    return '今天';
  }
  if (delta === 1) {
    return '昨天';
  }
  return `${parsed.value.getFullYear()}年${parsed.value.getMonth() + 1}月${parsed.value.getDate()}日`;
}

export function extractReplySnippet(plaintext: string): string | null {
  const normalized = plaintext.replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return null;
  }
  return normalized.slice(0, 72);
}

export function parseQuotedMessage(plaintext: string): { quote: string | null; body: string } {
  const match = plaintext.match(/^>\s*@([^:\n]{1,64}):\s*(.+)\n([\s\S]*)$/);
  if (!match) {
    return { quote: null, body: plaintext };
  }
  const body = match[3].trim();
  return {
    quote: `@${match[1]}: ${match[2]}`,
    body: body || plaintext,
  };
}
