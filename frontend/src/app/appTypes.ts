import type { ChatMessage } from '../types';

export type UIMessage = ChatMessage & {
  plaintext: string;
  decryptState: 'pending' | 'ok' | 'failed';
  pendingWidthPx: number;
};

export type SendQueueStatus = 'queued' | 'sending' | 'failed';

export type SendQueueItem = {
  id: string;
  text: string;
  status: SendQueueStatus;
  attempts: number;
  lastError: string | null;
  createdAt: number;
};

export type ThemeMode = 'light' | 'dark';
