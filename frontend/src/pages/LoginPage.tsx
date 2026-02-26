import type { FormEvent } from 'react';
import styles from './LoginPage.module.css';

type LoginPageProps = {
  username: string;
  password: string;
  busy: boolean;
  hasPendingInvite: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onUsernameChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
};

export function LoginPage({
  username,
  password,
  busy,
  hasPendingInvite,
  onSubmit,
  onUsernameChange,
  onPasswordChange,
}: LoginPageProps) {
  return (
    <main className={styles.shell}>
      <div className={`${styles.orb} ${styles.orbA}`} />
      <div className={`${styles.orb} ${styles.orbB}`} />
      <section className={`${styles.card} panel-elevated`}>
        <p className="kicker">Avant-Grade Encrypted Channel</p>
        <h1 className={styles.title}>
          E2EE
          <span>Conversation Engine</span>
        </h1>
        <p className={styles.lead}>浏览器端加密，服务端仅保存密文。公开注册关闭，账户由管理员创建。</p>
        {hasPendingInvite ? (
          <p className={`${styles.lead} ${styles.inviteHint}`}>检测到邀请链接，登录后将自动加入目标房间。</p>
        ) : null}

        <form className={styles.form} onSubmit={onSubmit}>
          <label>
            用户名
            <input
              value={username}
              onChange={(event) => onUsernameChange(event.target.value)}
              minLength={3}
              maxLength={32}
              required
            />
          </label>

          <label>
            密码
            <input
              type="password"
              value={password}
              onChange={(event) => onPasswordChange(event.target.value)}
              minLength={8}
              maxLength={128}
              required
            />
          </label>

          <button className="primary-btn" disabled={busy} type="submit">
            登录
          </button>
        </form>
      </section>
    </main>
  );
}
