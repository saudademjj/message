import type { ChatMessage } from '../types';

export type UIMessage = ChatMessage & {
  plaintext: string;
  decryptState: 'pending' | 'ok' | 'failed';
  pendingWidthPx: number;
  localQueueID?: string;
  localStatus?: 'queued' | 'sending' | 'failed';
  localSignature?: string;
};

export type SendQueueStatus = 'queued' | 'sending' | 'failed';

export type SendQueueItem = {
  id: string;
  roomID: number;
  text: string;
  status: SendQueueStatus;
  attempts: number;
  lastError: string | null;
  createdAt: number;
};

export type ThemeMode = 'light' | 'dark';
