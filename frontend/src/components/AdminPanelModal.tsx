import type { FormEvent, RefObject } from 'react';
import type { User } from '../types';
import styles from './AdminPanelModal.module.css';

type AdminPanelModalProps = {
  open: boolean;
  busy: boolean;
  authUserID: number;
  adminPage: number;
  adminPageCount: number;
  adminUserSearch: string;
  filteredUserCount: number;
  pagedManagedUsers: User[];
  newManagedUsername: string;
  newManagedPassword: string;
  modalRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onCreateUser: (event: FormEvent<HTMLFormElement>) => void;
  onDeleteUser: (user: User) => void;
  onAdminUserSearchChange: (value: string) => void;
  onNewManagedUsernameChange: (value: string) => void;
  onNewManagedPasswordChange: (value: string) => void;
  onPrevPage: () => void;
  onNextPage: () => void;
  onResetPage: () => void;
};

export function AdminPanelModal({
  open,
  busy,
  authUserID,
  adminPage,
  adminPageCount,
  adminUserSearch,
  filteredUserCount,
  pagedManagedUsers,
  newManagedUsername,
  newManagedPassword,
  modalRef,
  onClose,
  onCreateUser,
  onDeleteUser,
  onAdminUserSearchChange,
  onNewManagedUsernameChange,
  onNewManagedPasswordChange,
  onPrevPage,
  onNextPage,
  onResetPage,
}: AdminPanelModalProps) {
  if (!open) {
    return null;
  }

  return (
    <div className={styles.shell} role="dialog" aria-label="管理员面板" aria-modal="true">
      <button className={styles.backdrop} onClick={onClose} type="button" aria-label="关闭管理员面板" />
      <section className={`${styles.card} panel-elevated`} ref={modalRef} tabIndex={-1}>
        <header className={styles.head}>
          <h3>管理员用户管理</h3>
          <button className={`ghost-btn ${styles.close}`} onClick={onClose} type="button">
            关闭
          </button>
        </header>
        <div className={styles.grid}>
          <form className={`stack-form ${styles.createForm}`} onSubmit={onCreateUser}>
            <h4>创建用户</h4>
            <label>
              新用户名
              <input
                value={newManagedUsername}
                onChange={(event) => onNewManagedUsernameChange(event.target.value)}
                minLength={3}
                maxLength={32}
                required
              />
            </label>
            <label>
              初始密码
              <input
                type="password"
                value={newManagedPassword}
                onChange={(event) => onNewManagedPasswordChange(event.target.value)}
                minLength={8}
                maxLength={128}
                required
              />
            </label>
            <button className="primary-btn" disabled={busy} type="submit">
              创建用户
            </button>
          </form>

          <section className={styles.userPanel}>
            <div className={styles.userHead}>
              <h4>用户列表 ({filteredUserCount})</h4>
              <input
                value={adminUserSearch}
                onChange={(event) => {
                  onAdminUserSearchChange(event.target.value);
                  onResetPage();
                }}
                placeholder="搜索用户名 / ID / 角色"
              />
            </div>
            {pagedManagedUsers.length === 0 ? (
              <p className={styles.emptyState}>没有匹配的用户</p>
            ) : (
              <ul className="room-list managed-list">
                {pagedManagedUsers.map((user) => (
                  <li className="managed-item" key={user.id}>
                    <button className="active managed-user-chip" type="button">
                      #{user.id} {user.username} ({user.role})
                    </button>
                    <button
                      className="ghost-btn managed-delete-btn"
                      disabled={busy || user.role === 'admin' || user.id === authUserID}
                      onClick={() => {
                        onDeleteUser(user);
                      }}
                      type="button"
                    >
                      删除
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <footer className={styles.pagination}>
              <span>
                第 {Math.min(adminPage, adminPageCount)} / {adminPageCount} 页
              </span>
              <div className={styles.paginationActions}>
                <button
                  className="ghost-btn"
                  disabled={adminPage <= 1}
                  onClick={onPrevPage}
                  type="button"
                >
                  上一页
                </button>
                <button
                  className="ghost-btn"
                  disabled={adminPage >= adminPageCount}
                  onClick={onNextPage}
                  type="button"
                >
                  下一页
                </button>
              </div>
            </footer>
          </section>
        </div>
      </section>
    </div>
  );
}
