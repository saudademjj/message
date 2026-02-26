import type { FormEvent, RefObject } from 'react';
import styles from './RoomModal.module.css';

type RoomModalProps = {
  open: boolean;
  mode: 'create' | 'join';
  busy: boolean;
  newRoomName: string;
  joinRoomID: string;
  modalRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onSwitchMode: (mode: 'create' | 'join') => void;
  onCreateRoom: (event: FormEvent<HTMLFormElement>) => void;
  onJoinRoom: (event: FormEvent<HTMLFormElement>) => void;
  onNewRoomNameChange: (value: string) => void;
  onJoinRoomIDChange: (value: string) => void;
};

export function RoomModal({
  open,
  mode,
  busy,
  newRoomName,
  joinRoomID,
  modalRef,
  onClose,
  onSwitchMode,
  onCreateRoom,
  onJoinRoom,
  onNewRoomNameChange,
  onJoinRoomIDChange,
}: RoomModalProps) {
  if (!open) {
    return null;
  }

  return (
    <div className={styles.shell} role="dialog" aria-label="房间操作" aria-modal="true">
      <button className={styles.backdrop} onClick={onClose} type="button" aria-label="关闭房间操作" />
      <section className={`${styles.card} panel-elevated`} ref={modalRef} tabIndex={-1}>
        <header className={styles.head}>
          <h3>房间操作</h3>
          <button className={`ghost-btn ${styles.close}`} onClick={onClose} type="button">
            关闭
          </button>
        </header>
        <div className={styles.tabs} role="tablist" aria-label="房间操作切换">
          <button
            className={mode === 'create' ? `${styles.tab} ${styles.tabActive}` : styles.tab}
            onClick={() => onSwitchMode('create')}
            aria-selected={mode === 'create'}
            role="tab"
            type="button"
          >
            新建房间
          </button>
          <button
            className={mode === 'join' ? `${styles.tab} ${styles.tabActive}` : styles.tab}
            onClick={() => onSwitchMode('join')}
            aria-selected={mode === 'join'}
            role="tab"
            type="button"
          >
            加入房间
          </button>
        </div>
        {mode === 'create' ? (
          <form className={`${styles.stack} ${styles.form}`} onSubmit={onCreateRoom}>
            <label>
              新建房间
              <input
                value={newRoomName}
                onChange={(event) => onNewRoomNameChange(event.target.value)}
                maxLength={64}
                placeholder="room name"
                required
              />
            </label>
            <button className="primary-btn" disabled={busy} type="submit">
              创建并加入
            </button>
          </form>
        ) : (
          <form className={`${styles.stack} ${styles.form}`} onSubmit={onJoinRoom}>
            <label>
              输入房间 ID 或粘贴邀请链接
              <input
                value={joinRoomID}
                onChange={(event) => onJoinRoomIDChange(event.target.value)}
                placeholder="例如 1 或 https://...#invite=..."
                required
              />
            </label>
            <button className="ghost-btn" disabled={busy} type="submit">
              加入
            </button>
          </form>
        )}
      </section>
    </div>
  );
}
