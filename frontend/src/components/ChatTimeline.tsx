import { memo, useCallback, useEffect, useRef, useState, type RefObject, type UIEvent } from 'react';
import type { ChatMessage, User } from '../types';
import type { TimelineItem } from '../hooks/useTimelineItems';

type MessageView = ChatMessage & {
  plaintext: string;
  decryptState: 'pending' | 'ok' | 'failed';
  pendingWidthPx: number;
};

export type QuoteReplyPayload = {
  id: number;
  senderUsername: string;
  snippet: string;
};

type ChatTimelineProps = {
  timelineItems: TimelineItem<MessageView>[];
  messagesCount: number;
  authUserID: number;
  isRoomSwitching: boolean;
  messageReadReceipts: Record<number, number[]>;
  hasMoreHistory: boolean;
  historyLoading: boolean;
  onLoadMoreHistory: () => void;
  onMessageListScroll: () => void;
  onQuoteMessage: (payload: QuoteReplyPayload) => void;
  onEditMessage: (message: MessageView) => void;
  onRevokeMessage: (messageID: number) => void;
  onRequestRecovery: (messageID: number, senderUserID: number) => void;
  extractReplySnippet: (plaintext: string) => string | null;
  parseQuotedMessage: (plaintext: string) => { quote: string | null; body: string };
  renderMarkdown: (content: string, highlightQuery?: string) => string;
  focusMessageID: number | null;
  onFocusMessageHandled: (found: boolean) => void;
  formatTime: (timestamp: string) => string;
  avatarBackground: (seed: number) => string;
  avatarGlyph: (username: string) => string;
  messageListRef: RefObject<HTMLDivElement | null>;
  messageEndRef: RefObject<HTMLDivElement | null>;
  roomMembers: User[];
  roomSearchQuery?: string;
  onCopyInvite?: () => void;
};

/** Detect messages that contain only emoji (1–5 emoji, no other text). */
const EMOJI_ONLY_RE = /^(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}|\uFE0F|\u200D){1,10}$/u;
function isEmojiOnly(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 30) return false;
  return EMOJI_ONLY_RE.test(trimmed);
}

export const ChatTimeline = memo(function ChatTimeline({
  timelineItems,
  messagesCount,
  authUserID,
  isRoomSwitching,
  messageReadReceipts,
  hasMoreHistory,
  historyLoading,
  onLoadMoreHistory,
  onMessageListScroll,
  onQuoteMessage,
  onEditMessage,
  onRevokeMessage,
  onRequestRecovery,
  extractReplySnippet,
  parseQuotedMessage,
  renderMarkdown,
  focusMessageID,
  onFocusMessageHandled,
  formatTime,
  avatarBackground,
  avatarGlyph,
  messageListRef,
  messageEndRef,
  roomMembers,
  roomSearchQuery,
  onCopyInvite,
}: ChatTimelineProps) {
  const [highlightedMessageID, setHighlightedMessageID] = useState<number | null>(null);
  const [activeMessageId, setActiveMessageId] = useState<number | string | null>(null);
  const topLoadGuardRef = useRef(false);

  const handleScroll = useCallback((event: UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    if (target.scrollTop < 120 && hasMoreHistory && !historyLoading && !topLoadGuardRef.current) {
      topLoadGuardRef.current = true;
      onLoadMoreHistory();
      window.setTimeout(() => {
        topLoadGuardRef.current = false;
      }, 300);
    }
    onMessageListScroll();
  }, [hasMoreHistory, historyLoading, onLoadMoreHistory, onMessageListScroll]);

  useEffect(() => {
    if (!focusMessageID) {
      return;
    }
    const element = document.getElementById(`message-${focusMessageID}`);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      onFocusMessageHandled(true);
    } else {
      onFocusMessageHandled(false);
      return;
    }
    let clearTimer: number | null = null;
    const startTimer = window.setTimeout(() => {
      setHighlightedMessageID(focusMessageID);
      clearTimer = window.setTimeout(() => {
        setHighlightedMessageID((previous) => (previous === focusMessageID ? null : previous));
      }, 1600);
    }, 0);
    return () => {
      window.clearTimeout(startTimer);
      if (clearTimer !== null) {
        window.clearTimeout(clearTimer);
      }
    };
  }, [focusMessageID, onFocusMessageHandled]);

  const isInitialHistoryLoading = historyLoading && messagesCount === 0;

  const messageListClassName = [
    'message-list',
    isInitialHistoryLoading ? 'history-loading' : '',
    isRoomSwitching ? 'room-switching' : '',
  ].filter(Boolean).join(' ');

  const showSkeleton = isInitialHistoryLoading;

  return (
    <div
      className={messageListClassName}
      onScroll={handleScroll}
      ref={messageListRef}
    >
      {isRoomSwitching ? (
        <div className="room-switch-mask" role="status">
          正在切换安全会话...
        </div>
      ) : null}
      {hasMoreHistory && !isRoomSwitching ? (
        <button className="load-more-btn" disabled={historyLoading} onClick={onLoadMoreHistory} type="button">
          {historyLoading ? '加载中...' : '加载更早消息'}
        </button>
      ) : null}
      {showSkeleton ? (
        <div className={historyLoading ? 'history-loading-skeleton' : 'history-loading-skeleton fade-out'} aria-hidden="true">
          <span className="skeleton" />
          <span className="skeleton" />
          <span className="skeleton" />
        </div>
      ) : null}

      {timelineItems.map((item, index) => {
        const isLast = index === timelineItems.length - 1;
        const shellClassName = isLast ? 'timeline-item-shell last' : 'timeline-item-shell';

        if (item.kind === 'divider') {
          return (
            <div className={shellClassName} key={item.key}>
              <div className="time-divider">
                <span>{item.label}</span>
              </div>
            </div>
          );
        }

        const message = item.message;
        const own = message.senderId === authUserID;
        if (message.revokedAt) {
          const revokedEventClassName = [
            'message-system-event',
            'revoke-event',
            highlightedMessageID === message.id ? 'jump-highlight' : '',
          ].filter(Boolean).join(' ');
          return (
            <div className={shellClassName} key={item.key}>
              <div
                className={revokedEventClassName}
                id={`message-${message.id}`}
                data-message-id={message.id}
              >
                <span>{own ? '你已撤回一条消息' : '对方已撤回一条消息'}</span>
              </div>
            </div>
          );
        }

        const classes = ['bubble'];
        if (own) {
          classes.push('own');
        } else {
          classes.push('peer');
        }
        if (message.decryptState === 'failed') {
          classes.push('failed');
        }
        if (highlightedMessageID === message.id) {
          classes.push('jump-highlight');
        }

        // Add pending class if the message ID is a string (UUID generated by local queue)
        const isPending = typeof message.id === 'string';
        if (isPending) {
          classes.push('pending');
        }

        // Detect emoji-only messages for special styling
        if (message.decryptState === 'ok' && !message.revokedAt && isEmojiOnly(message.plaintext)) {
          classes.push('emoji-only');
        }

        const readBy = messageReadReceipts[message.id] ?? [];
        const expectedDeliveries = own
          ? Math.max(0, Object.keys(message.payload.wrappedKeys ?? {}).length - 1)
          : 0;
        const deliveryText = !own
          ? ''
          : expectedDeliveries === 0
            ? '本地'
            : readBy.length >= expectedDeliveries
              ? '已读'
              : readBy.length > 0
                ? `已读 ${readBy.length}/${expectedDeliveries}`
                : '未读'
        const deliveryClass = !own
          ? ''
          : expectedDeliveries > 0 && readBy.length >= expectedDeliveries
            ? 'delivered'
            : 'sent';
        const parsed = message.decryptState === 'ok'
          ? parseQuotedMessage(message.plaintext)
          : { quote: null, body: message.plaintext };
        const canReply = message.decryptState === 'ok' && !message.revokedAt;
        const canEdit = own && !message.revokedAt;
        const isActive = activeMessageId === message.id;

        return (
          <div className={shellClassName} key={item.key}>
            <article
              className={classes.join(' ')}
              id={`message-${message.id}`}
              data-message-id={message.id}
            >
              {!own && (
                <div className="bubble-avatar-container">
                  <span
                    className="avatar-chip"
                    style={{ background: avatarBackground(message.senderId) }}
                  >
                    {avatarGlyph(message.senderUsername)}
                  </span>
                </div>
              )}

              <div className="bubble-content-wrapper">
                {!own && (
                  <header className="bubble-sender-name">
                    <strong>{message.senderUsername}</strong>
                  </header>
                )}

                {parsed.quote ? (
                  <div className="quote-preview-external">
                    <p>{parsed.quote}</p>
                  </div>
                ) : null}

                <div className="bubble-row">
                  {own && (
                    <div className="bubble-meta-external own">
                      <span className={`delivery-chip ${deliveryClass}`}>
                        {deliveryText}
                        {readBy.length > 0 && (
                          <div className="read-by-tooltip">
                            已经由以下用户阅览：
                            <ul>
                              {readBy.map((userId) => {
                                const member = roomMembers.find((m) => m.id === userId);
                                return (
                                  <li key={userId}>
                                    {member ? `${member.username} (#${userId})` : `User #${userId}`}
                                  </li>
                                );
                              })}
                            </ul>
                          </div>
                        )}
                      </span>
                      {message.editedAt && !message.revokedAt ? <span className="edited-chip">已编辑</span> : null}
                      <time title={new Date(message.createdAt).toLocaleString()}>{formatTime(message.createdAt)}</time>
                    </div>
                  )}

                  <div
                    className={`bubble-main ${isActive ? 'active' : ''}`}
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest('button, a')) return;
                      setActiveMessageId(prev => prev === message.id ? null : message.id);
                    }}
                  >
                    {message.decryptState === 'pending' ? (
                      <div
                        className="decrypt-pending skeleton"
                        aria-label="Decrypting"
                        style={{ width: `${message.pendingWidthPx}px` }}
                      >
                        <span />
                        <span />
                        <span />
                      </div>
                    ) : (
                      <div className="bubble-body">
                        {message.decryptState === 'failed' ? (
                          <p className="bubble-text decrypt-failed">[!] {parsed.body}</p>
                        ) : (
                          <div
                            className="markdown-body"
                            dangerouslySetInnerHTML={{ __html: renderMarkdown(parsed.body, roomSearchQuery) }}
                          />
                        )}
                      </div>
                    )}

                    {message.decryptState === 'ok' && isActive ? (
                      <div className="bubble-actions-floating">
                        {canReply ? (
                          <button
                            className="ghost-btn bubble-action-btn"
                            onClick={() => {
                              const snippet = extractReplySnippet(message.plaintext);
                              if (!snippet) {
                                return;
                              }
                              onQuoteMessage({
                                id: message.id,
                                senderUsername: message.senderUsername,
                                snippet,
                              });
                              setActiveMessageId(null);
                            }}
                            type="button"
                          >
                            回复
                          </button>
                        ) : null}
                        {canEdit ? (
                          <button
                            className="ghost-btn bubble-action-btn"
                            onClick={() => {
                              onEditMessage(message);
                              setActiveMessageId(null);
                            }}
                            type="button"
                          >
                            编辑
                          </button>
                        ) : null}
                        {canEdit ? (
                          <button
                            className="ghost-btn bubble-action-btn"
                            onClick={() => {
                              onRevokeMessage(message.id);
                              setActiveMessageId(null);
                            }}
                            type="button"
                          >
                            撤回
                          </button>
                        ) : null}
                      </div>
                    ) : null}

                    {message.decryptState === 'failed' && !own && isActive ? (
                      <div className="bubble-actions-floating">
                        <button
                          className="ghost-btn bubble-action-btn"
                          onClick={() => {
                            onRequestRecovery(message.id, message.senderId);
                            setActiveMessageId(null);
                          }}
                          type="button"
                        >
                          请求重同步
                        </button>
                      </div>
                    ) : null}
                  </div>

                  {!own && (
                    <div className="bubble-meta-external peer">
                      <time title={new Date(message.createdAt).toLocaleString()}>{formatTime(message.createdAt)}</time>
                      {message.editedAt && !message.revokedAt ? <span className="edited-chip">已编辑</span> : null}
                    </div>
                  )}
                </div>
              </div>
            </article>
          </div>
        );
      })}

      {messagesCount === 0 && !historyLoading ? (
        <div className="empty-state" role="status">
          <div className="empty-illustration" aria-hidden="true">
            <div className="lock-core" />
            <div className="scan-ring ring-a" />
            <div className="scan-ring ring-b" />
          </div>
          <p>该房间暂无消息，建立安全通道并发送第一条密文。</p>
          {onCopyInvite && (
            <button className="primary-btn" onClick={onCopyInvite} type="button" style={{ marginTop: '10px' }}>
              + 复制邀请链接
            </button>
          )}
        </div>
      ) : null}
      <div className="message-end-anchor" ref={messageEndRef} />
    </div>
  );
});
