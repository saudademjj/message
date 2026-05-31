import { useState, type RefObject } from 'react';
import type { DeviceSnapshot } from '../types';
import styles from './DevicePanelModal.module.css';

type DevicePanelModalProps = {
  open: boolean;
  busy: boolean;
  devices: DeviceSnapshot[];
  modalRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  onRefresh: () => void;
  onRename: (deviceID: string, deviceName: string) => void;
  onRevoke: (deviceID: string) => void;
  onApprove: (deviceID: string) => void;
  onSaveRecoveryBackup: (phrase: string) => void;
};

function formatDeviceTimestamp(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return value;
  }
  return new Date(parsed).toLocaleString();
}

export function DevicePanelModal({
  open,
  busy,
  devices,
  modalRef,
  onClose,
  onRefresh,
  onRename,
  onRevoke,
  onApprove,
  onSaveRecoveryBackup,
}: DevicePanelModalProps) {
  const [recoveryPhrase, setRecoveryPhrase] = useState('');
  if (!open) {
    return null;
  }

  return (
    <div className={styles.shell} role="dialog" aria-label="设备管理" aria-modal="true">
      <button className={styles.backdrop} onClick={onClose} type="button" aria-label="关闭设备管理" />
      <section className={`${styles.card} panel-elevated`} ref={modalRef} tabIndex={-1}>
        <header className={styles.head}>
          <h3>设备管理</h3>
          <div className={styles.headActions}>
            <button className="ghost-btn" disabled={busy} onClick={onRefresh} type="button">
              刷新
            </button>
            <button className={`ghost-btn ${styles.close}`} onClick={onClose} type="button">
              关闭
            </button>
          </div>
        </header>

        <section className={styles.recoveryBox}>
          <div>
            <h4>恢复短语备份</h4>
            <p>当前浏览器私钥不可导出；备份会保存加密恢复元数据，后续密钥迁移后可扩展为完整私钥恢复。</p>
          </div>
          <div className={styles.recoveryActions}>
            <input
              aria-label="恢复短语"
              onChange={(event) => setRecoveryPhrase(event.target.value)}
              placeholder="输入要用于本设备备份的恢复短语"
              type="password"
              value={recoveryPhrase}
            />
            <button
              className="ghost-btn"
              disabled={busy || recoveryPhrase.trim().length < 8}
              onClick={() => onSaveRecoveryBackup(recoveryPhrase)}
              type="button"
            >
              保存备份
            </button>
          </div>
        </section>

        {devices.length === 0 ? (
          <p className={styles.emptyState}>暂无设备记录</p>
        ) : (
          <ul className={styles.deviceList}>
            {devices.map((device) => (
              <DeviceListItem
                busy={busy}
                device={device}
                key={`${device.deviceId}:${device.deviceName}:${device.revokedAt ?? ''}`}
                onRename={onRename}
                onRevoke={onRevoke}
                onApprove={onApprove}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

type DeviceListItemProps = {
  busy: boolean;
  device: DeviceSnapshot;
  onRename: (deviceID: string, deviceName: string) => void;
  onRevoke: (deviceID: string) => void;
  onApprove: (deviceID: string) => void;
};

function DeviceListItem({
  busy,
  device,
  onRename,
  onRevoke,
  onApprove,
}: DeviceListItemProps) {
  const [draft, setDraft] = useState(device.deviceName);
  const revoked = Boolean(device.revokedAt);
  const pending = !revoked && device.trustStatus === 'pending';

  return (
    <li className={styles.deviceItem}>
      <div className={styles.deviceHead}>
        <strong>{device.deviceName}</strong>
        <div className={styles.badges}>
          {device.current ? <span className={styles.currentBadge}>当前设备</span> : null}
          <span className={revoked ? styles.revokedBadge : styles.activeBadge}>
            {revoked ? '已撤销' : pending ? '待批准' : '活跃'}
          </span>
        </div>
      </div>
      <dl className={styles.meta}>
        <div>
          <dt>设备 ID</dt>
          <dd>{device.deviceId}</dd>
        </div>
        <div>
          <dt>最近在线</dt>
          <dd>{formatDeviceTimestamp(device.lastSeenAt)}</dd>
        </div>
        {device.pendingSince ? (
          <div>
            <dt>待批准</dt>
            <dd>{formatDeviceTimestamp(device.pendingSince)}</dd>
          </div>
        ) : null}
      </dl>
      {!revoked ? (
        <div className={styles.actions}>
          <label>
            设备名称
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              maxLength={64}
            />
          </label>
          <button
            className="ghost-btn"
            disabled={busy || draft.trim() === device.deviceName.trim() || !draft.trim()}
            onClick={() => onRename(device.deviceId, draft)}
            type="button"
          >
            保存名称
          </button>
          {pending ? (
            <button
              className="ghost-btn"
              disabled={busy || device.current}
              onClick={() => onApprove(device.deviceId)}
              type="button"
            >
              批准设备
            </button>
          ) : null}
          <button
            className={`ghost-btn ${styles.danger}`}
            disabled={busy}
            onClick={() => onRevoke(device.deviceId)}
            type="button"
          >
            撤销设备
          </button>
        </div>
      ) : null}
    </li>
  );
}
