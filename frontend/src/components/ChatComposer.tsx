import { memo, useState, useRef, useEffect, useCallback } from 'react';
import type { FormEvent, KeyboardEvent, RefObject } from 'react';
import EmojiPicker, { Theme, EmojiStyle } from 'emoji-picker-react';
import { createPortal } from 'react-dom';
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
  themeMode: 'light' | 'dark';
  cryptoReady: boolean;
  wsConnected: boolean;
  roomMembers: User[];
};

type EmojiPickerLayout = {
  top: number;
  left: number;
  width: number;
  height: number;
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
  themeMode,
  cryptoReady,
  wsConnected,
  roomMembers,
}: ChatComposerProps) {
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const pickerPopoverRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [pickerLayout, setPickerLayout] = useState<EmojiPickerLayout | null>(null);

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
    if (!showEmojiPicker) {
      return;
    }

    const handleGlobalPointerDown = (event: MouseEvent | TouchEvent) => {
      const target = event.target as Node | null;
      if (!target) {
        return;
      }

      if (
        pickerPopoverRef.current?.contains(target) ||
        triggerRef.current?.contains(target)
      ) {
        return;
      }

      setShowEmojiPicker(false);
    };

    document.addEventListener('mousedown', handleGlobalPointerDown);
    document.addEventListener('touchstart', handleGlobalPointerDown, { passive: true });

    return () => {
      document.removeEventListener('mousedown', handleGlobalPointerDown);
      document.removeEventListener('touchstart', handleGlobalPointerDown);
    };
  }, [showEmojiPicker]);

  const calculatePickerLayout = useCallback((): EmojiPickerLayout | null => {
    if (!triggerRef.current) return null;

    const rect = triggerRef.current.getBoundingClientRect();
    const chatMainRect = triggerRef.current.closest('.chat-main')?.getBoundingClientRect() ?? null;
    const viewportHeight = window.innerHeight;
    const viewportWidth = window.innerWidth;
    const isMobile = viewportWidth <= 640;
    const maxPickerWidthFromViewport = Math.max(180, viewportWidth - 24);
    const maxPickerWidthFromLayout = !isMobile && chatMainRect
      ? Math.max(180, chatMainRect.width - 24)
      : maxPickerWidthFromViewport;
    const maxPickerWidth = Math.min(maxPickerWidthFromViewport, maxPickerWidthFromLayout);
    const pickerWidth = Math.min(320, maxPickerWidth);
    const pickerHeight = Math.max(220, Math.min(400, viewportHeight - 24));

    let top: number;
    let left: number;

    if (isMobile) {
      top = Math.max(12, viewportHeight - pickerHeight - 12);
      left = Math.max(12, Math.min((viewportWidth - pickerWidth) / 2, viewportWidth - pickerWidth - 12));
    } else {
      if (rect.top >= pickerHeight + 12) {
        top = rect.top - pickerHeight - 12;
      } else {
        top = rect.bottom + 12;
      }

      if (top + pickerHeight > viewportHeight - 12) {
        top = Math.max(12, viewportHeight - pickerHeight - 12);
      }

      const minLeft = chatMainRect
        ? Math.max(12, chatMainRect.left + 12)
        : 12;
      const maxLeftInViewport = viewportWidth - pickerWidth - 12;
      const maxLeftInChatMain = chatMainRect
        ? chatMainRect.right - pickerWidth - 12
        : maxLeftInViewport;
      const maxLeft = Math.min(maxLeftInViewport, maxLeftInChatMain);

      if (maxLeft <= minLeft) {
        left = minLeft;
      } else {
        left = Math.max(minLeft, Math.min(rect.left, maxLeft));
      }
    }

    return { top, left, width: pickerWidth, height: pickerHeight };
  }, []);

  useEffect(() => {
    if (!showEmojiPicker) {
      return;
    }

    const syncPickerLayout = () => {
      setPickerLayout(calculatePickerLayout());
    };

    syncPickerLayout();
    window.addEventListener('resize', syncPickerLayout);
    window.addEventListener('scroll', syncPickerLayout, true);

    return () => {
      window.removeEventListener('resize', syncPickerLayout);
      window.removeEventListener('scroll', syncPickerLayout, true);
    };
  }, [calculatePickerLayout, showEmojiPicker]);

  const handleToggleEmojiPicker = useCallback(() => {
    setShowEmojiPicker((prev) => {
      if (!prev) {
        setPickerLayout(calculatePickerLayout());
      }
      return !prev;
    });
  }, [calculatePickerLayout]);

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
          <div className="emoji-picker-wrapper">
            <button
              type="button"
              className="ghost-btn emoji-trigger-btn"
              onClick={handleToggleEmojiPicker}
              title="插入表情"
              ref={triggerRef}
            >
              😊
            </button>
            {showEmojiPicker && pickerLayout
              ? createPortal(
                <div
                  className="emoji-picker-popover"
                  style={{ top: pickerLayout.top, left: pickerLayout.left, width: pickerLayout.width }}
                  ref={pickerPopoverRef}
                >
                  <EmojiPicker
                    onEmojiClick={handleEmojiClick}
                    autoFocusSearch={false}
                    theme={themeMode === 'dark' ? Theme.DARK : Theme.LIGHT}
                    emojiStyle={EmojiStyle.NATIVE}
                    lazyLoadEmojis={true}
                    width={pickerLayout.width}
                    height={pickerLayout.height}
                    searchPlaceHolder="搜索表情..."
                    skinTonesDisabled={false}
                  />
                </div>,
                document.body
              )
              : null}
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
              disabled={!isRoomSelected || !draft.trim() || !cryptoReady}
              title={
                !isRoomSelected ? '未选择房间' :
                  !cryptoReady ? '加密初始化中' :
                    !draft.trim() ? '请输入内容' :
                      !wsConnected ? '当前离线，点击后会暂存到发送队列' :
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
