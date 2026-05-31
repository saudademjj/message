import { useState, type FormEvent, type RefObject } from 'react';
import { avatarBackground, avatarGlyph } from '../app/helpers';
import styles from './ProfileModal.module.css';

type ProfileModalProps = {
  open: boolean;
  busy: boolean;
  user: {
    id: number;
    username: string;
    role: 'admin' | 'user';
  };
  device: {
    deviceId: string;
    deviceName: string;
    lastSeenAt: string;
  };
  isAdmin: boolean;
  modalRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onUpdateUsername: (username: string) => Promise<boolean>;
  onChangePassword: (current: string, next: string) => Promise<boolean>;
};

const ADMIN_LOCK_NOTE = '管理员账号请通过部署配置修改';
const USERNAME_MIN = 3;
const USERNAME_MAX = 32;
const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

function formatLastSeen(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return value;
  }
  return new Date(parsed).toLocaleString();
}

export function ProfileModal({
  open,
  busy,
  user,
  device,
  isAdmin,
  modalRef,
  onClose,
  onUpdateUsername,
  onChangePassword,
}: ProfileModalProps) {
  const [usernameDraft, setUsernameDraft] = useState(user.username);
  const [usernameError, setUsernameError] = useState('');

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');

  if (!open) {
    return null;
  }

  const handleUsernameSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isAdmin) {
      return;
    }
    setUsernameError('');
    const trimmed = usernameDraft.trim();
    if (trimmed.length < USERNAME_MIN || trimmed.length > USERNAME_MAX) {
      setUsernameError(`用户名长度需在 ${USERNAME_MIN}-${USERNAME_MAX} 个字符之间`);
      return;
    }
    // Success is signalled through the global toast (setInfo) by the controller;
    // the modal only keeps the form open on failure. It does not render its own
    // success text to avoid duplicate feedback.
    void onUpdateUsername(trimmed).catch(() => {
      // The controller surfaces the error via the toast layer; keep the form open.
    });
  };

  const handlePasswordSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isAdmin) {
      return;
    }
    setPasswordError('');
    if (newPassword.length < PASSWORD_MIN || newPassword.length > PASSWORD_MAX) {
      setPasswordError(`新密码长度需在 ${PASSWORD_MIN}-${PASSWORD_MAX} 个字符之间`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('两次输入的新密码不一致');
      return;
    }
    // Success feedback comes from the global toast; only clear the fields when
    // the change actually succeeded. A no-op (e.g. no active session) resolves
    // to false, so the entered values are preserved.
    void onChangePassword(currentPassword, newPassword)
      .then((succeeded) => {
        if (succeeded) {
          setCurrentPassword('');
          setNewPassword('');
          setConfirmPassword('');
        }
      })
      .catch(() => {
        // The controller surfaces the error via the toast layer; keep the entered values.
      });
  };

  const usernameUnchanged = usernameDraft.trim() === user.username.trim();

  return (
    <div className={styles.shell} role="dialog" aria-label="个人主页与账号设置" aria-modal="true">
      <button className={styles.backdrop} onClick={onClose} type="button" aria-label="关闭个人主页" />
      <section className={`${styles.card} panel-elevated`} ref={modalRef} tabIndex={-1}>
        <header className={styles.head}>
          <h3>个人主页</h3>
          <button className={`ghost-btn ${styles.close}`} onClick={onClose} type="button">
            关闭
          </button>
        </header>

        <div className={styles.profileHeader}>
          <span
            className={styles.avatar}
            style={{ background: avatarBackground(user.id) }}
            aria-hidden="true"
          >
            {avatarGlyph(user.username)}
          </span>
          <div className={styles.profileMeta}>
            <div className={styles.profileNameRow}>
              <strong className={styles.profileName}>{user.username}</strong>
              <span className={user.role === 'admin' ? styles.roleBadgeAdmin : styles.roleBadge}>
                {user.role === 'admin' ? '管理员' : '成员'}
              </span>
            </div>
            <p className={styles.profileDevice}>{device.deviceName}</p>
            <p className={styles.profileSeen}>最近在线: {formatLastSeen(device.lastSeenAt)}</p>
          </div>
        </div>

        <form className={styles.section} onSubmit={handleUsernameSubmit}>
          <h4>修改用户名</h4>
          <label>
            用户名
            <input
              value={usernameDraft}
              onChange={(event) => setUsernameDraft(event.target.value)}
              maxLength={USERNAME_MAX}
              disabled={isAdmin || busy}
              autoComplete="username"
            />
          </label>
          {isAdmin ? <p className={styles.note}>{ADMIN_LOCK_NOTE}</p> : null}
          {usernameError ? <p className={styles.error} role="alert">{usernameError}</p> : null}
          <button
            className="primary-btn"
            disabled={isAdmin || busy || usernameUnchanged}
            type="submit"
          >
            保存用户名
          </button>
        </form>

        <form className={styles.section} onSubmit={handlePasswordSubmit}>
          <h4>修改密码</h4>
          <label>
            当前密码
            <input
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              type="password"
              maxLength={PASSWORD_MAX}
              disabled={isAdmin || busy}
              autoComplete="current-password"
            />
          </label>
          <label>
            新密码
            <input
              value={newPassword}
              onChange={(event) => setNewPassword(event.target.value)}
              type="password"
              maxLength={PASSWORD_MAX}
              disabled={isAdmin || busy}
              autoComplete="new-password"
            />
          </label>
          <label>
            确认新密码
            <input
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              type="password"
              maxLength={PASSWORD_MAX}
              disabled={isAdmin || busy}
              autoComplete="new-password"
            />
          </label>
          {isAdmin ? <p className={styles.note}>{ADMIN_LOCK_NOTE}</p> : null}
          {passwordError ? <p className={styles.error} role="alert">{passwordError}</p> : null}
          <button
            className="primary-btn"
            disabled={isAdmin || busy || !currentPassword || !newPassword || !confirmPassword}
            type="submit"
          >
            更新密码
          </button>
        </form>
      </section>
    </div>
  );
}
