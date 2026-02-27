import { useCallback } from 'react';
import type { Dispatch, FormEvent, KeyboardEvent, MutableRefObject, SetStateAction } from 'react';
import type { Identity } from '../../crypto';
import type { AuthSession } from '../../contexts/AuthContext';
import type { QuoteReplyPayload } from '../../components/ChatTimeline';
import { TYPING_IDLE_MS } from './constants';

type QueueItemState = {
  status: string;
};

type UseComposerControllerArgs = {
  auth: AuthSession | null;
  selectedRoomID: number | null;
  draft: string;
  setDraft: Dispatch<SetStateAction<string>>;
  replyTarget: QuoteReplyPayload | null;
  setReplyTarget: Dispatch<SetStateAction<QuoteReplyPayload | null>>;
  typingIdleTimerRef: MutableRefObject<number | null>;
  emitTypingStatus: (isTyping: boolean) => void;
  queueText: (text: string) => void;
  sendQueue: QueueItemState[];
  flushSendQueue: () => Promise<void>;
  wsConnected: boolean;
  identity: Identity | null;
  identityBound: boolean;
  setInfo: Dispatch<SetStateAction<string>>;
  setError: Dispatch<SetStateAction<string>>;
  isMobileInputMode: boolean;
  setFocusMessageID: Dispatch<SetStateAction<number | null>>;
  draftInputRef: MutableRefObject<HTMLTextAreaElement | null>;
};

export function useComposerController({
  auth,
  selectedRoomID,
  draft,
  setDraft,
  replyTarget,
  setReplyTarget,
  typingIdleTimerRef,
  emitTypingStatus,
  queueText,
  sendQueue,
  flushSendQueue,
  wsConnected,
  identity,
  identityBound,
  setInfo,
  setError,
  isMobileInputMode,
  setFocusMessageID,
  draftInputRef,
}: UseComposerControllerArgs) {
  const queueCurrentDraft = useCallback(() => {
    if (!auth || !selectedRoomID) {
      if (!auth) {
        setError('请先登录');
      } else {
        setError('请先选择房间');
      }
      return;
    }

    const text = draft.trim();
    if (!text) {
      return;
    }
    if (!identity || !identityBound) {
      setError('本地安全身份未就绪或与当前会话不一致，已阻止发送');
      return;
    }

    const composed = replyTarget
      ? `> @${replyTarget.senderUsername}: ${replyTarget.snippet}\n${text}`
      : text;

    queueText(composed);
    setDraft('');
    setReplyTarget(null);
    if (typingIdleTimerRef.current !== null) {
      window.clearTimeout(typingIdleTimerRef.current);
      typingIdleTimerRef.current = null;
    }
    emitTypingStatus(false);

    if (!wsConnected) {
      setInfo('消息已暂存，连接恢复后自动发送');
      return;
    }

    const nextPendingCount = sendQueue.filter((item) => item.status !== 'failed').length + 1;
    if (nextPendingCount > 1) {
      setInfo(`消息已加入发送队列 (${nextPendingCount})`);
    }
    void flushSendQueue();
  }, [
    auth,
    draft,
    emitTypingStatus,
    flushSendQueue,
    identity,
    identityBound,
    queueText,
    replyTarget,
    selectedRoomID,
    sendQueue,
    setDraft,
    setError,
    setInfo,
    setReplyTarget,
    typingIdleTimerRef,
    wsConnected,
  ]);

  const handleSend = useCallback((event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    queueCurrentDraft();
  }, [queueCurrentDraft]);

  const handleDraftChange = useCallback((value: string) => {
    setDraft(value);
    if (!auth || !selectedRoomID) {
      return;
    }
    if (!value.trim()) {
      if (typingIdleTimerRef.current !== null) {
        window.clearTimeout(typingIdleTimerRef.current);
        typingIdleTimerRef.current = null;
      }
      emitTypingStatus(false);
      return;
    }

    emitTypingStatus(true);
    if (typingIdleTimerRef.current !== null) {
      window.clearTimeout(typingIdleTimerRef.current);
    }
    typingIdleTimerRef.current = window.setTimeout(() => {
      typingIdleTimerRef.current = null;
      emitTypingStatus(false);
    }, TYPING_IDLE_MS);
  }, [auth, emitTypingStatus, selectedRoomID, setDraft, typingIdleTimerRef]);

  const handleDraftKeyDown = useCallback((event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isMobileInputMode) {
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      queueCurrentDraft();
    }
  }, [isMobileInputMode, queueCurrentDraft]);

  const handleQuoteMessage = useCallback((payload: QuoteReplyPayload) => {
    setReplyTarget(payload);
    draftInputRef.current?.focus();
  }, [draftInputRef, setReplyTarget]);

  const handleCancelReply = useCallback(() => {
    setReplyTarget(null);
  }, [setReplyTarget]);

  const handleJumpToReply = useCallback(() => {
    if (!replyTarget) {
      return;
    }
    setFocusMessageID(replyTarget.id);
  }, [replyTarget, setFocusMessageID]);

  return {
    queueCurrentDraft,
    handleSend,
    handleDraftChange,
    handleDraftKeyDown,
    handleQuoteMessage,
    handleCancelReply,
    handleJumpToReply,
  };
}
