import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { ChatComposer, type FailedSendQueueItem } from '../components/ChatComposer';
import { ChatTimeline, type QuoteReplyPayload } from '../components/ChatTimeline';
import { formatRoomActivityLabel } from '../app/helpers';
import type { UIMessage, ThemeMode } from '../app/appTypes';
import type { TimelineItem } from '../hooks/useTimelineItems';
import type { Peer, Room, User } from '../types';
import { buildRecipientAddress } from '../crypto/utils';

type ChatPageProps = {
  authUser: {
    id: number;
    username: string;
    role: 'admin' | 'user';
  };
  sidebarOpen: boolean;
  closeSidebar: () => void;
  toggleSidebar: () => void;
  sidebarRef: RefObject<HTMLElement | null>;
  roomListQuery: string;
  onRoomListQueryChange: (value: string) => void;
  filteredRooms: Room[];
  selectedRoomID: number | null;
  onSelectRoom: (roomID: number) => void;
  openRoomModal: (mode: 'create' | 'join') => void;
  openDeviceModal: () => void;
  openAdminModal: () => void;
  onLogout: () => void;
  onOpenProfile: () => void;
  managedUsersCount: number;
  selectedRoom: Room | null;
  busy: boolean;
  onCopyInviteLink: () => void;
  onDeleteRoom: () => void;
  roomSearchQuery: string;
  onRoomSearchQueryChange: (value: string) => void;
  roomSearchMetaText: string;
  onSearchPrev: () => void;
  onSearchNext: () => void;
  canSearchNavigate: boolean;
  wsStateClass: string;
  wsStateText: string;
  notificationsSupported: boolean;
  notificationPermission: NotificationPermission;
  onEnableNotifications: () => void;
  themeMode: ThemeMode;
  onToggleThemeMode: () => void;
  peerPanelOpen: boolean;
  onTogglePeerPanel: () => void;
  onClosePeerPanel: () => void;
  peerPopoverRef: RefObject<HTMLDivElement | null>;
  peerCount: number;
  localKeyVersions: number;
  pendingQueueCount: number;
  failedQueueCount: number;
  onlinePeers: Peer[];
  peerSafetyNumbers: Record<string, string>;
  avatarBackground: (seed: number) => string;
  avatarGlyph: (username: string) => string;
  messageReadReceipts: Record<number, number[]>;
  hasMoreHistory: boolean;
  historyLoading: boolean;
  isRoomSwitching: boolean;
  messageEndRef: RefObject<HTMLDivElement | null>;
  messageListRef: RefObject<HTMLDivElement | null>;
  messagesCount: number;
  timelineItems: TimelineItem<UIMessage>[];
  roomMembers: User[];
  onLoadMoreHistory: () => void;
  onMessageListScroll: () => void;
  onEditMessage: (message: UIMessage) => void;
  onRevokeMessage: (messageID: number) => void;
  onQuoteMessage: (payload: QuoteReplyPayload) => void;
  onRequestRecovery: (messageID: number, senderUserID: number) => void;
  parseQuotedMessage: (plaintext: string) => { quote: string | null; body: string };
  extractReplySnippet: (plaintext: string) => string | null;
  renderMarkdown: (content: string, highlightQuery?: string) => string;
  formatTime: (timestamp: string) => string;
  focusMessageID: number | null;
  onFocusMessageHandled: (found: boolean) => void;
  unreadIncomingCount: number;
  onJumpToLatest: () => void;
  typingIndicatorText: string;
  draft: string;
  draftInputRef: RefObject<HTMLTextAreaElement | null>;
  failedQueueItems: FailedSendQueueItem[];
  onCancelReply: () => void;
  onJumpToReply: () => void;
  onDiscardFailed: (itemID: string) => void;
  onDraftChange: (value: string) => void;
  onDraftKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  onRetryAllFailed: () => void;
  onRetryFailed: (itemID: string) => void;
  onSend: (event: FormEvent<HTMLFormElement>) => void;
  summarizeDraft: (text: string) => string;
  isMobileInputMode: boolean;
  replyTarget: QuoteReplyPayload | null;
  cryptoReady: boolean;
  wsConnected: boolean;
};

export function ChatPage({
  authUser,
  sidebarOpen,
  closeSidebar,
  toggleSidebar,
  sidebarRef,
  roomListQuery,
  onRoomListQueryChange,
  filteredRooms,
  selectedRoomID,
  onSelectRoom,
  openRoomModal,
  openDeviceModal,
  openAdminModal,
  onLogout,
  onOpenProfile,
  managedUsersCount,
  selectedRoom,
  busy,
  onCopyInviteLink,
  onDeleteRoom,
  roomSearchQuery,
  onRoomSearchQueryChange,
  roomSearchMetaText,
  onSearchPrev,
  onSearchNext,
  canSearchNavigate,
  wsStateClass,
  wsStateText,
  notificationsSupported,
  notificationPermission,
  onEnableNotifications,
  themeMode,
  onToggleThemeMode,
  peerPanelOpen,
  onTogglePeerPanel,
  onClosePeerPanel,
  peerPopoverRef,
  peerCount,
  localKeyVersions,
  pendingQueueCount,
  failedQueueCount,
  onlinePeers,
  peerSafetyNumbers,
  avatarBackground,
  avatarGlyph,
  messageReadReceipts,
  hasMoreHistory,
  historyLoading,
  isRoomSwitching,
  messageEndRef,
  messageListRef,
  messagesCount,
  timelineItems,
  roomMembers,
  onLoadMoreHistory,
  onMessageListScroll,
  onEditMessage,
  onRevokeMessage,
  onQuoteMessage,
  onRequestRecovery,
  parseQuotedMessage,
  extractReplySnippet,
  renderMarkdown,
  formatTime,
  focusMessageID,
  onFocusMessageHandled,
  unreadIncomingCount,
  onJumpToLatest,
  typingIndicatorText,
  draft,
  draftInputRef,
  failedQueueItems,
  onCancelReply,
  onJumpToReply,
  onDiscardFailed,
  onDraftChange,
  onDraftKeyDown,
  onRetryAllFailed,
  onRetryFailed,
  onSend,
  summarizeDraft,
  isMobileInputMode,
  replyTarget,
  cryptoReady,
  wsConnected,
}: ChatPageProps) {
  const peerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const [peerPopoverPosition, setPeerPopoverPosition] = useState<{
    top: number;
    right: number;
    maxHeight: number;
  } | null>(null);

  const computePeerPopoverPosition = useCallback(() => {
    const trigger = peerTriggerRef.current;
    if (!trigger) {
      return null;
    }
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    // Mobile uses a bottom-sheet layout from CSS; skip inline positioning.
    if (viewportWidth <= 900) {
      return null;
    }
    const rect = trigger.getBoundingClientRect();
    const top = rect.bottom + 10;
    const right = Math.max(12, viewportWidth - rect.right);
    const maxHeight = Math.max(160, viewportHeight - top - 16);
    return { top, right, maxHeight };
  }, []);

  useEffect(() => {
    if (!peerPanelOpen) {
      return;
    }
    const sync = () => {
      setPeerPopoverPosition(computePeerPopoverPosition());
    };
    sync();
    window.addEventListener('resize', sync);
    window.addEventListener('scroll', sync, true);
    return () => {
      window.removeEventListener('resize', sync);
      window.removeEventListener('scroll', sync, true);
    };
  }, [computePeerPopoverPosition, peerPanelOpen]);

  return (
    <main className="chat-shell">
      <div className="stage-glow stage-left" />
      <div className="stage-glow stage-right" />
      <button
        aria-label="关闭侧边栏"
        className={sidebarOpen ? 'drawer-backdrop open' : 'drawer-backdrop'}
        onClick={closeSidebar}
        type="button"
      />

      <aside
        className={sidebarOpen ? 'sidebar panel-elevated open' : 'sidebar panel-elevated'}
        ref={sidebarRef}
        tabIndex={-1}
      >
        <header className="sidebar-head">
          <p className="kicker">Identity Locked</p>
          <h2>E2EE Chat</h2>
          <button className="ghost-btn sidebar-close" onClick={closeSidebar} type="button">
            收起菜单
          </button>
          <button className="profile-card-btn" onClick={onOpenProfile} type="button" aria-label="打开个人主页">
            <span className="profile-card-avatar" style={{ background: avatarBackground(authUser.id) }}>
              {avatarGlyph(authUser.username)}
            </span>
            <span className="profile-card-meta">
              <span className="profile-card-name">{authUser.username}</span>
              <span className="profile-card-role">{authUser.role === 'admin' ? '管理员' : '成员'}</span>
            </span>
          </button>
          <button className="ghost-btn" onClick={onLogout} type="button">
            退出
          </button>
        </header>

        <section className="sidebar-card">
          <h3>我的房间</h3>
          <input
            aria-label="搜索房间"
            className="room-search-input"
            onChange={(event) => onRoomListQueryChange(event.target.value)}
            placeholder="全局搜索房间名称 / ID"
            value={roomListQuery}
          />
          <ul className="room-list">
            {filteredRooms.map((room) => (
              <li key={room.id}>
                <button
                  className={room.id === selectedRoomID ? 'active' : ''}
                  onClick={() => {
                    onSelectRoom(room.id);
                    closeSidebar();
                  }}
                  type="button"
                >
                  <span className="room-list-main">
                    <span className="room-list-name">
                      #{room.id} {room.name}
                    </span>
                    <span className="room-list-activity">
                      {formatRoomActivityLabel(room.lastActivityAt)}
                    </span>
                  </span>
                  <span className="room-list-subline">
                    <span>{room.lastMessageId ? '最近有消息' : '等待首条消息'}</span>
                    {room.unreadCount > 0 ? (
                      <span className="room-unread-badge" aria-label={`${room.unreadCount} 条未读消息`}>
                        {room.unreadCount > 99 ? '99+' : room.unreadCount}
                      </span>
                    ) : null}
                  </span>
                </button>
              </li>
            ))}
            {filteredRooms.length === 0 ? (
              <li>
                <p className="room-list-empty">没有匹配的房间，换个关键词试试</p>
              </li>
            ) : null}
          </ul>
        </section>

        <section className="sidebar-card quick-actions">
          <h3>房间操作</h3>
          <button className="primary-btn room-action-btn" onClick={() => openRoomModal('create')} type="button">
            + 新建房间
          </button>
          <button className="ghost-btn room-action-btn" onClick={() => openRoomModal('join')} type="button">
            + 邀请加入
          </button>
          <button className="ghost-btn room-action-btn" onClick={openDeviceModal} type="button">
            设备管理
          </button>
          {authUser.role === 'admin' ? (
            <button className="ghost-btn room-action-btn admin-launch-btn" onClick={openAdminModal} type="button">
              管理员面板 ({managedUsersCount})
            </button>
          ) : null}
        </section>
      </aside>

      <section className="chat-main panel-elevated">
        <header className="chat-header">
          <div className="chat-header-row-top">
            <button className="ghost-btn sidebar-toggle" onClick={toggleSidebar} type="button">
              {sidebarOpen ? '关闭' : '菜单'}
            </button>
            <div className="chat-title-group">
              <h2>{selectedRoom ? `#${selectedRoom.id} ${selectedRoom.name}` : '请选择房间'}</h2>
            </div>
            {selectedRoom ? (
              <div className="room-header-actions">
                <button className="ghost-btn room-action-pill" disabled={busy} onClick={onCopyInviteLink} type="button">
                  复制邀请
                </button>
                <button className="ghost-btn room-action-pill room-action-danger" disabled={busy} onClick={onDeleteRoom} type="button">
                  删除
                </button>
              </div>
            ) : null}
          </div>

          <div className="chat-header-row-status">
            <span className={`status-pill ${wsStateClass}`}>
              <i />
              <span className="status-text">{wsStateText}</span>
            </span>
            <div className="status-actions">
              {notificationsSupported ? (
                <button className="status-pill neutral notify-pill" onClick={onEnableNotifications} type="button">
                  {notificationPermission === 'granted' ? '通知开' : '通知'}
                </button>
              ) : null}
              <button className="status-pill neutral theme-pill" onClick={onToggleThemeMode} type="button">
                {themeMode === 'dark' ? '浅色' : '暗色'}
              </button>
              <button
                className={peerPanelOpen ? 'status-pill neutral peer-pill open' : 'status-pill neutral peer-pill'}
                onClick={onTogglePeerPanel}
                ref={peerTriggerRef}
                type="button"
              >
                详情
              </button>
            </div>
            <div className="search-inline">
              <input
                aria-label="搜索当前房间消息"
                className="room-search-input"
                disabled={!selectedRoomID}
                onChange={(event) => onRoomSearchQueryChange(event.target.value)}
                placeholder="搜索消息..."
                value={roomSearchQuery}
              />
              {roomSearchQuery ? (
                <div className="search-nav-group">
                  <span className="room-search-meta">{roomSearchMetaText}</span>
                  <button
                    className="ghost-btn room-search-nav"
                    disabled={!selectedRoomID || !canSearchNavigate}
                    onClick={onSearchPrev}
                    type="button"
                  >
                    上
                  </button>
                  <button
                    className="ghost-btn room-search-nav"
                    disabled={!selectedRoomID || !canSearchNavigate}
                    onClick={onSearchNext}
                    type="button"
                  >
                    下
                  </button>
                </div>
              ) : null}
            </div>
            {peerPanelOpen
              ? createPortal(
                <>
                  <div className="popover-backdrop" onClick={onClosePeerPanel} aria-hidden="true" />
                  <div
                    className="peer-popover peer-popover-floating"
                    ref={peerPopoverRef}
                    role="dialog"
                    aria-label="连接详情"
                    aria-modal="true"
                    tabIndex={-1}
                    style={
                      peerPopoverPosition
                        ? {
                            top: peerPopoverPosition.top,
                            right: peerPopoverPosition.right,
                            maxHeight: peerPopoverPosition.maxHeight,
                          }
                        : undefined
                    }
                  >
                    <ul className="connection-metrics">
                      <li>在线公钥: {peerCount}</li>
                      <li>本地密钥版本: {localKeyVersions}</li>
                      <li>待发送队列: {pendingQueueCount}</li>
                      <li>失败待重试: {failedQueueCount}</li>
                    </ul>
                    {onlinePeers.length === 0 ? (
                      <p>当前房间暂无在线设备</p>
                    ) : (
                      <ul>
                        {onlinePeers.map((peer) => {
                          const peerAddress = buildRecipientAddress(peer.userId, peer.deviceId);
                          const safetyNumber = peerSafetyNumbers[peerAddress];
                          return (
                            <li key={peerAddress}>
                              <span className="avatar-chip" style={{ background: avatarBackground(peer.userId) }}>
                                {avatarGlyph(peer.username)}
                              </span>
                              <span className="peer-meta">
                                {peer.username}
                                <small>
                                  #{peer.userId} · {peer.deviceName || peer.deviceId}
                                  {safetyNumber
                                    ? ` · Safety # ${safetyNumber}`
                                    : ''}
                                </small>
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                </>,
                document.body
              )
              : null}
          </div>
        </header>

        <div className="chat-body">
          <ChatTimeline
            authUserID={authUser.id}
            avatarBackground={avatarBackground}
            avatarGlyph={avatarGlyph}
            extractReplySnippet={extractReplySnippet}
            formatTime={formatTime}
            hasMoreHistory={hasMoreHistory}
            historyLoading={historyLoading}
            isRoomSwitching={isRoomSwitching}
            messageReadReceipts={messageReadReceipts}
            messageEndRef={messageEndRef}
            messageListRef={messageListRef}
            messagesCount={messagesCount}
            onLoadMoreHistory={onLoadMoreHistory}
            onMessageListScroll={onMessageListScroll}
            onEditMessage={onEditMessage}
            onRevokeMessage={onRevokeMessage}
            onQuoteMessage={onQuoteMessage}
            onRequestRecovery={onRequestRecovery}
            parseQuotedMessage={parseQuotedMessage}
            renderMarkdown={renderMarkdown}
            focusMessageID={focusMessageID}
            onFocusMessageHandled={onFocusMessageHandled}
            timelineItems={timelineItems}
            roomMembers={roomMembers}
            roomSearchQuery={roomSearchQuery}
            onCopyInvite={onCopyInviteLink}
          />

          {unreadIncomingCount > 0 ? (
            <button className="unread-jump-btn" onClick={onJumpToLatest} type="button">
              有 {unreadIncomingCount} 条新消息
            </button>
          ) : null}

          <p className="typing-indicator" aria-live="polite">
            {typingIndicatorText || '\u00a0'}
          </p>
        </div>

        <footer className="chat-footer">
          <ChatComposer
            draft={draft}
            draftInputRef={draftInputRef}
            failedQueueItems={failedQueueItems}
            isRoomSelected={Boolean(selectedRoomID)}
            onCancelReply={onCancelReply}
            onJumpToReply={onJumpToReply}
            onDiscardFailed={onDiscardFailed}
            onDraftChange={onDraftChange}
            onDraftKeyDown={onDraftKeyDown}
            onRetryAllFailed={onRetryAllFailed}
            onRetryFailed={onRetryFailed}
            onSend={onSend}
            pendingQueueCount={pendingQueueCount}
            replyTarget={replyTarget}
            summarizeDraft={summarizeDraft}
            isMobileInputMode={isMobileInputMode}
            themeMode={themeMode}
            cryptoReady={cryptoReady}
            wsConnected={wsConnected}
            roomMembers={roomMembers}
          />
        </footer>
      </section>
    </main>
  );
}
