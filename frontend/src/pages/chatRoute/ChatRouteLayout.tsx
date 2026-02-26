import type { FormEvent } from 'react';
import {
  avatarBackground,
  avatarGlyph,
  extractReplySnippet,
  formatTime,
  parseQuotedMessage,
  summarizeDraft,
} from '../../app/helpers';
import type { UIMessage } from '../../app/appTypes';
import { AdminPanelModal } from '../../components/AdminPanelModal';
import { RoomModal } from '../../components/RoomModal';
import { ToastLayer } from '../../components/ToastLayer';
import { renderMarkdownSafe } from '../../markdown';
import { ChatPage } from '../ChatPage';
import type { useAdminPanelController } from './useAdminPanelController';
import type { useChatRouteActions } from './useChatRouteActions';
import type { useChatRouteDataControllers } from './useChatRouteDataControllers';
import type { useChatRouteState } from './useChatRouteState';
import type { useChatRouteViewModel } from './useChatRouteViewModel';
import type { useComposerController } from './useComposerController';

type ChatRouteControllers = ReturnType<typeof useChatRouteDataControllers>;
type ChatRouteState = ReturnType<typeof useChatRouteState>;
type ChatRouteActions = ReturnType<typeof useChatRouteActions>;

type ChatRouteLayoutProps = {
  authUser: {
    id: number;
    username: string;
    role: 'admin' | 'user';
  };
  managedUsersCount: number;
  busy: boolean;
  roomsController: ChatRouteControllers['roomsController'];
  messagesController: ChatRouteControllers['messagesController'];
  sendQueueController: ChatRouteControllers['sendQueueController'];
  adminController: ReturnType<typeof useAdminPanelController>;
  composerController: ReturnType<typeof useComposerController>;
  viewModel: ReturnType<typeof useChatRouteViewModel>;
  ui: Pick<
    ChatRouteState,
    | 'sidebarOpen'
    | 'closeSidebar'
    | 'toggleSidebar'
    | 'sidebarRef'
    | 'peerPanelOpen'
    | 'peerPopoverRef'
    | 'roomModalCardRef'
    | 'adminModalCardRef'
    | 'adminModalOpen'
    | 'adminUserSearch'
    | 'setAdminUserSearch'
    | 'adminPage'
    | 'setAdminPage'
    | 'newManagedUsername'
    | 'setNewManagedUsername'
    | 'newManagedPassword'
    | 'setNewManagedPassword'
    | 'draft'
    | 'draftInputRef'
    | 'isMobileInputMode'
    | 'themeMode'
    | 'notificationPermission'
    | 'replyTarget'
    | 'toasts'
    | 'pauseToastDismissal'
    | 'resumeToastDismissal'
    | 'dismissToast'
  >;
  actions: ChatRouteActions;
  identityReady: boolean;
  wsConnected: boolean;
};

export function ChatRouteLayout({
  authUser,
  managedUsersCount,
  busy,
  roomsController,
  messagesController,
  sendQueueController,
  adminController,
  composerController,
  viewModel,
  ui,
  actions,
  identityReady,
  wsConnected,
}: ChatRouteLayoutProps) {
  return (
    <>
      <ChatPage
        authUser={authUser}
        sidebarOpen={ui.sidebarOpen}
        closeSidebar={ui.closeSidebar}
        toggleSidebar={ui.toggleSidebar}
        sidebarRef={ui.sidebarRef}
        roomListQuery={roomsController.roomListQuery}
        onRoomListQueryChange={roomsController.setRoomListQuery}
        filteredRooms={roomsController.filteredRooms}
        selectedRoomID={roomsController.selectedRoomID}
        onSelectRoom={roomsController.setSelectedRoomID}
        openRoomModal={roomsController.openRoomModal}
        openAdminModal={actions.handleOpenAdminModal}
        onLogout={actions.handleLogout}
        managedUsersCount={managedUsersCount}
        selectedRoom={roomsController.selectedRoom}
        roomMembers={roomsController.roomMembers}
        busy={busy}
        onCopyInviteLink={actions.handleCopyInviteLinkWrapper}
        onDeleteRoom={actions.handleDeleteRoomWrapper}
        roomSearchQuery={messagesController.roomSearchQuery}
        onRoomSearchQueryChange={messagesController.setRoomSearchQuery}
        roomSearchMetaText={viewModel.roomSearchMetaText}
        onSearchPrev={messagesController.handleSearchPrev}
        onSearchNext={messagesController.handleSearchNext}
        canSearchNavigate={messagesController.roomSearchMatches.length > 0}
        wsStateClass={viewModel.wsStateClass}
        wsStateText={viewModel.wsStateText}
        notificationsSupported={typeof Notification !== 'undefined'}
        notificationPermission={ui.notificationPermission}
        onEnableNotifications={actions.handleEnableNotificationsWrapper}
        themeMode={ui.themeMode}
        onToggleThemeMode={actions.handleToggleThemeMode}
        peerPanelOpen={ui.peerPanelOpen}
        onTogglePeerPanel={actions.handleTogglePeerPanel}
        onClosePeerPanel={actions.handleClosePeerPanel}
        peerPopoverRef={ui.peerPopoverRef}
        peerCount={messagesController.peerCount}
        localKeyVersions={viewModel.localKeyVersions}
        pendingQueueCount={sendQueueController.pendingQueueCount}
        failedQueueCount={sendQueueController.failedQueueCount}
        onlinePeers={messagesController.onlinePeers}
        peerSafetyNumbers={messagesController.peerSafetyNumbers}
        avatarBackground={avatarBackground}
        avatarGlyph={avatarGlyph}
        messageReadReceipts={messagesController.messageReadReceipts}
        hasMoreHistory={messagesController.hasMoreHistory}
        historyLoading={messagesController.historyLoading}
        isRoomSwitching={messagesController.isRoomSwitching}
        messageEndRef={messagesController.messageEndRef}
        messageListRef={messagesController.messageListRef}
        messagesCount={messagesController.timelineItems.filter((item) => item.kind === 'message').length}
        timelineItems={messagesController.timelineItems}
        onLoadMoreHistory={messagesController.handleLoadMoreHistory}
        onMessageListScroll={messagesController.handleMessageListScroll}
        onEditMessage={actions.handleEditMessageWrapper as (message: UIMessage) => void}
        onRevokeMessage={messagesController.handleRevokeMessage}
        onQuoteMessage={composerController.handleQuoteMessage}
        onRequestRecovery={messagesController.handleRequestDecryptRecovery}
        parseQuotedMessage={parseQuotedMessage}
        extractReplySnippet={extractReplySnippet}
        renderMarkdown={renderMarkdownSafe}
        formatTime={formatTime}
        focusMessageID={messagesController.focusMessageID}
        onFocusMessageHandled={messagesController.handleFocusMessageHandled}
        unreadIncomingCount={messagesController.unreadIncomingCount}
        onJumpToLatest={messagesController.handleJumpToLatest}
        typingIndicatorText={messagesController.typingIndicatorText}
        draft={ui.draft}
        draftInputRef={ui.draftInputRef}
        failedQueueItems={viewModel.failedQueueViewItems}
        onCancelReply={composerController.handleCancelReply}
        onJumpToReply={composerController.handleJumpToReply}
        onDiscardFailed={sendQueueController.discardQueueItem}
        onDraftChange={composerController.handleDraftChange}
        onDraftKeyDown={composerController.handleDraftKeyDown}
        onRetryAllFailed={sendQueueController.retryAllFailedItems}
        onRetryFailed={sendQueueController.retryQueueItem}
        onSend={composerController.handleSend as (event: FormEvent<HTMLFormElement>) => void}
        summarizeDraft={summarizeDraft}
        isMobileInputMode={ui.isMobileInputMode}
        replyTarget={ui.replyTarget}
        cryptoReady={identityReady}
        wsConnected={wsConnected}
      />
      <RoomModal
        open={roomsController.roomModalOpen}
        mode={roomsController.roomModalMode}
        busy={busy}
        newRoomName={roomsController.newRoomName}
        joinRoomID={roomsController.joinRoomID}
        modalRef={ui.roomModalCardRef}
        onClose={actions.handleCloseRoomModal}
        onSwitchMode={roomsController.setRoomModalMode}
        onCreateRoom={actions.handleCreateRoomWrapper}
        onJoinRoom={actions.handleJoinRoomWrapper}
        onNewRoomNameChange={roomsController.setNewRoomName}
        onJoinRoomIDChange={roomsController.setJoinRoomID}
      />
      {authUser.role === 'admin' ? (
        <AdminPanelModal
          open={ui.adminModalOpen}
          busy={busy}
          authUserID={authUser.id}
          adminPage={ui.adminPage}
          adminPageCount={adminController.adminPageCount}
          adminUserSearch={ui.adminUserSearch}
          filteredUserCount={adminController.filteredManagedUsers.length}
          pagedManagedUsers={adminController.pagedManagedUsers}
          newManagedUsername={ui.newManagedUsername}
          newManagedPassword={ui.newManagedPassword}
          modalRef={ui.adminModalCardRef}
          onClose={actions.handleCloseAdminModal}
          onCreateUser={adminController.handleCreateManagedUser}
          onDeleteUser={adminController.handleDeleteManagedUserWrapper}
          onAdminUserSearchChange={ui.setAdminUserSearch}
          onNewManagedUsernameChange={ui.setNewManagedUsername}
          onNewManagedPasswordChange={ui.setNewManagedPassword}
          onPrevPage={adminController.handlePrevPage}
          onNextPage={adminController.handleNextPage}
          onResetPage={adminController.handleResetPage}
        />
      ) : null}
      <ToastLayer
        toasts={ui.toasts}
        onPause={ui.pauseToastDismissal}
        onResume={ui.resumeToastDismissal}
        onDismiss={ui.dismissToast}
      />
    </>
  );
}
