import { memo, useState, useRef, useEffect, useCallback } from 'react';
import type { FormEvent, KeyboardEvent, RefObject } from 'react';
import EmojiPicker, { Theme, EmojiStyle } from 'emoji-picker-react';
import type { User } from '../types';

export type ComposerReplyTarget = {
  id: number;
  senderUsername: string;
  snippet: string;
};

export type FailedSendQueueItem = {
  id: string;
  text: string;
  lastError: string | null;
};

type ChatComposerProps = {
  draft: string;
  replyTarget: ComposerReplyTarget | null;
  pendingQueueCount: number;
  failedQueueItems: FailedSendQueueItem[];
  draftInputRef: RefObject<HTMLTextAreaElement | null>;
  onDraftChange: (value: string) => void;
  onDraftKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onSend: (event: FormEvent<HTMLFormElement>) => void;
  onCancelReply: () => void;
  onJumpToReply: () => void;
  onRetryAllFailed: () => void;
  onRetryFailed: (itemID: string) => void;
  onDiscardFailed: (itemID: string) => void;
  summarizeDraft: (text: string) => string;
  isRoomSelected: boolean;
  isMobileInputMode: boolean;
  cryptoReady: boolean;
  wsConnected: boolean;
  roomMembers: User[];
};

export const ChatComposer = memo(function ChatComposer({
  draft,
  replyTarget,
  pendingQueueCount,
  failedQueueItems,
  draftInputRef,
  onDraftChange,
  onDraftKeyDown,
  onSend,
  onCancelReply,
  onJumpToReply,
  onRetryAllFailed,
  onRetryFailed,
  onDiscardFailed,
  summarizeDraft,
  isRoomSelected,
  isMobileInputMode,
  cryptoReady,
  wsConnected,
  roomMembers,
}: ChatComposerProps) {
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const pickerRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [pickerPosition, setPickerPosition] = useState<{ top: number; left: number } | null>(null);

  // Mention State
  const [mentionState, setMentionState] = useState<{
    visible: boolean;
    query: string;
    activeIndex: number;
    caretIndex: number;
  }>({
    visible: false,
    query: '',
    activeIndex: 0,
    caretIndex: 0,
  });

  const mentionListRef = useRef<HTMLUListElement | null>(null);

  const filteredMembers = roomMembers.filter((m) =>
    m.username.toLowerCase().includes(mentionState.query.toLowerCase())
  );

  useEffect(() => {
    const handleGlobalClick = (e: MouseEvent) => {
      if (showEmojiPicker) {
        const target = e.target as Node;
        if (
          pickerRef.current?.contains(target) ||
          triggerRef.current?.contains(target)
        ) {
          return;
        }
        setShowEmojiPicker(false);
      }
    };
    document.addEventListener('mousedown', handleGlobalClick);
    return () => document.removeEventListener('mousedown', handleGlobalClick);
  }, [showEmojiPicker]);

  const calculatePickerPosition = useCallback(() => {
    if (!triggerRef.current) return null;
    const rect = triggerRef.current.getBoundingClientRect();
    const pickerHeight = 400;
    const pickerWidth = 320;
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    const isMobile = viewportWidth <= 640;
    let top: number;
    let left: number;
    if (isMobile) {
      top = viewportHeight - pickerHeight - 12;
      left = 12;
    } else {
      if (rect.top >= pickerHeight + 12) {
        top = rect.top - pickerHeight - 12;
      } else {
        top = rect.bottom + 12;
      }
      left = Math.max(12, Math.min(rect.left, viewportWidth - pickerWidth - 12));
    }
    return { top, left };
  }, []);

  const handleToggleEmojiPicker = useCallback(() => {
    setShowEmojiPicker((prev) => {
      if (!prev) {
        const position = calculatePickerPosition();
        setPickerPosition(position);
      }
      return !prev;
    });
  }, [calculatePickerPosition]);

  const handleEmojiClick = (emojiData: { emoji: string }) => {
    const input = draftInputRef.current;
    if (input) {
      const start = input.selectionStart;
      const end = input.selectionEnd;
      const nextCaret = start + emojiData.emoji.length;
      const newDraft = draft.substring(0, start) + emojiData.emoji + draft.substring(end);
      // Keep focus in the same user gesture. Some mobile browsers block async focus.
      input.focus({ preventScroll: true });
      onDraftChange(newDraft);

      // Restore cursor after React applies the updated textarea value.
      window.requestAnimationFrame(() => {
        const nextInput = draftInputRef.current;
        if (!nextInput) {
          return;
        }
        const clampedCaret = Math.min(nextCaret, nextInput.value.length);
        nextInput.setSelectionRange(clampedCaret, clampedCaret);
        if (document.activeElement !== nextInput) {
          nextInput.focus({ preventScroll: true });
        }
      });
    } else {
      onDraftChange(draft + emojiData.emoji);
    }
  };

  const handleDraftChange = (value: string) => {
    onDraftChange(value);
    const input = draftInputRef.current;
    if (!input) return;

    // Use setTimeout so selectionStart is accurate after render
    window.setTimeout(() => {
      const caretPos = input.selectionStart;
      const textBeforeCaret = value.slice(0, caretPos);
      const mentionMatch = textBeforeCaret.match(/@([a-zA-Z0-9_-]*)$/);

      if (mentionMatch) {
        setMentionState((prev) => ({
          ...prev,
          visible: true,
          query: mentionMatch[1],
          caretIndex: caretPos,
        }));
      } else {
        setMentionState((prev) => ({ ...prev, visible: false }));
      }
    }, 0);
  };

  const insertMention = (username: string) => {
    const input = draftInputRef.current;
    if (!input) return;

    const { caretIndex, query } = mentionState;
    const textBeforeMention = draft.slice(0, caretIndex - query.length - 1);
    const textAfterMention = draft.slice(caretIndex);

    const newDraft = `${textBeforeMention}@${username} ${textAfterMention}`;
    onDraftChange(newDraft);
    setMentionState({ visible: false, query: '', activeIndex: 0, caretIndex: 0 });

    window.setTimeout(() => {
      const newCaretPos = textBeforeMention.length + username.length + 2;
      input.setSelectionRange(newCaretPos, newCaretPos);
      input.focus();
    }, 0);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionState.visible && filteredMembers.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setMentionState((prev) => ({
          ...prev,
          activeIndex: (prev.activeIndex + 1) % filteredMembers.length,
        }));
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setMentionState((prev) => ({
          ...prev,
          activeIndex: (prev.activeIndex - 1 + filteredMembers.length) % filteredMembers.length,
        }));
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        insertMention(filteredMembers[mentionState.activeIndex].username);
        return;
      }
      if (event.key === 'Escape') {
        setMentionState((prev) => ({ ...prev, visible: false }));
        return;
      }
    }
    onDraftKeyDown(event);
  };

  return (
    <>
      <form className={replyTarget ? 'composer with-reply' : 'composer'} onSubmit={onSend}>
        {!cryptoReady ? (
          <div className="crypto-init-hint">
            <span className="crypto-init-dot" />
            加密密钥初始化中...
          </div>
        ) : null}
        {replyTarget ? (
          <div className="reply-inline">
            <button className="reply-jump-btn" onClick={onJumpToReply} type="button">
              引用 #{replyTarget.id} @{replyTarget.senderUsername}: {replyTarget.snippet}
            </button>
            <button className="ghost-btn" onClick={onCancelReply} type="button">
              取消
            </button>
          </div>
        ) : null}

        <div className="composer-row">
          <div className="emoji-picker-wrapper" ref={pickerRef}>
            <button
              type="button"
              className="ghost-btn emoji-trigger-btn"
              onClick={handleToggleEmojiPicker}
              title="插入表情"
              ref={triggerRef}
            >
              😊
            </button>
            {showEmojiPicker && pickerPosition && (
              <div
                className="emoji-picker-popover"
                style={{ top: pickerPosition.top, left: pickerPosition.left }}
              >
                <EmojiPicker
                  onEmojiClick={handleEmojiClick}
                  autoFocusSearch={false}
                  theme={Theme.AUTO}
                  emojiStyle={EmojiStyle.NATIVE}
                  lazyLoadEmojis={true}
                  width={320}
                  height={400}
                  searchPlaceHolder="搜索表情..."
                  skinTonesDisabled={false}
                />
              </div>
            )}
          </div>

          <div className="composer-input-wrapper">
            <textarea
              onChange={(event) => handleDraftChange(event.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isMobileInputMode ? '输入消息（使用发送按钮）' : '输入消息（回车发送，Shift+回车换行）'}
              ref={draftInputRef}
              rows={1}
              value={draft}
            />
            {mentionState.visible && filteredMembers.length > 0 && (
              <ul className="mention-popover" ref={mentionListRef}>
                {filteredMembers.map((member, index) => (
                  <li
                    key={member.id}
                    className={index === mentionState.activeIndex ? 'active' : ''}
                    onMouseDown={(e) => {
                      e.preventDefault(); // Prevents input losing focus
                      insertMention(member.username);
                    }}
                  >
                    @{member.username}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="composer-actions">
            {pendingQueueCount > 0 ? <span className="queue-hint">队列 {pendingQueueCount}</span> : null}
            {failedQueueItems.length > 0 ? (
              <button className="ghost-btn queue-retry-all-btn" onClick={onRetryAllFailed} type="button">
                重试失败消息 ({failedQueueItems.length})
              </button>
            ) : null}
            <button
              className="primary-btn send-btn"
              disabled={!isRoomSelected || !draft.trim() || !wsConnected || !cryptoReady}
              title={
                !isRoomSelected ? '未选择房间' :
                  !wsConnected ? 'WebSocket 未连接' :
                    !cryptoReady ? '加密初始化中' :
                      !draft.trim() ? '请输入内容' :
                        ''
              }
              type="submit"
            >
              <span aria-hidden="true" className="send-icon" />
              <span className="send-text">发送</span>
            </button>
          </div>
        </div>
      </form>
      {failedQueueItems.length > 0 ? (
        <section className="queue-failed-panel" aria-live="polite">
          <h3>发送失败</h3>
          <ul className="queue-failed-list">
            {failedQueueItems.map((item) => (
              <li className="queue-failed-item" key={item.id}>
                <div className="queue-failed-content">
                  <p title={item.text}>{summarizeDraft(item.text)}</p>
                  <small>{item.lastError ?? '发送失败，请重试'}</small>
                </div>
                <div className="queue-failed-actions">
                  <button
                    className="ghost-btn queue-retry-btn"
                    onClick={() => onRetryFailed(item.id)}
                    type="button"
                  >
                    重试
                  </button>
                  <button
                    className="ghost-btn queue-discard-btn"
                    onClick={() => onDiscardFailed(item.id)}
                    type="button"
                  >
                    移除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
});
