import { useCallback, useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { ApiClient } from '../api';
import type { AuthSession } from '../contexts/AuthContext';
import type { DeviceSnapshot } from '../types';

type UseDevicesArgs = {
  api: ApiClient;
  auth: AuthSession | null;
  selectedRoomID: number | null;
  sendJSON: (frame: unknown) => boolean;
  reportError: (reason: unknown, fallback: string) => void;
  setInfo: Dispatch<SetStateAction<string>>;
};

type UseDevicesResult = {
  devices: DeviceSnapshot[];
  deviceBusy: boolean;
  deviceModalOpen: boolean;
  openDeviceModal: () => void;
  closeDeviceModal: () => void;
  refreshDevices: () => Promise<void>;
  renameDevice: (deviceID: string, deviceName: string) => Promise<void>;
  revokeDevice: (deviceID: string) => Promise<boolean>;
  approveDevice: (deviceID: string) => Promise<void>;
  saveRecoveryBackup: (phrase: string) => Promise<void>;
};

export function sortDeviceSnapshots(devices: DeviceSnapshot[]): DeviceSnapshot[] {
  return [...devices].sort((left, right) => {
    const leftRevoked = Boolean(left.revokedAt);
    const rightRevoked = Boolean(right.revokedAt);
    if (leftRevoked !== rightRevoked) {
      return leftRevoked ? 1 : -1;
    }
    const leftSeenAt = Date.parse(left.lastSeenAt);
    const rightSeenAt = Date.parse(right.lastSeenAt);
    const leftSeen = Number.isNaN(leftSeenAt) ? 0 : leftSeenAt;
    const rightSeen = Number.isNaN(rightSeenAt) ? 0 : rightSeenAt;
    if (leftSeen !== rightSeen) {
      return rightSeen - leftSeen;
    }
    return left.deviceId.localeCompare(right.deviceId);
  });
}

export function useDevices({
  api,
  auth,
  selectedRoomID,
  sendJSON,
  reportError,
  setInfo,
}: UseDevicesArgs): UseDevicesResult {
  const [devices, setDevices] = useState<DeviceSnapshot[]>([]);
  const [deviceBusy, setDeviceBusy] = useState(false);
  const [deviceModalOpen, setDeviceModalOpen] = useState(false);

  const refreshDevices = useCallback(async () => {
    if (!auth) {
      setDevices([]);
      return;
    }
    setDeviceBusy(true);
    try {
      const response = await api.listDevices();
      setDevices(sortDeviceSnapshots(response.devices));
    } catch (reason: unknown) {
      reportError(reason, '加载设备列表失败');
    } finally {
      setDeviceBusy(false);
    }
  }, [api, auth, reportError]);

  useEffect(() => {
    if (!auth) {
      setDevices([]);
      setDeviceModalOpen(false);
    }
  }, [auth]);

  useEffect(() => {
    if (!deviceModalOpen || !auth) {
      return;
    }
    void refreshDevices();
  }, [auth, deviceModalOpen, refreshDevices]);

  const openDeviceModal = useCallback(() => {
    setDeviceModalOpen(true);
  }, []);

  const closeDeviceModal = useCallback(() => {
    setDeviceModalOpen(false);
  }, []);

  const renameDevice = useCallback(async (deviceID: string, deviceName: string) => {
    const trimmedName = deviceName.trim();
    if (!trimmedName) {
      return;
    }
    setDeviceBusy(true);
    try {
      const response = await api.renameDevice(deviceID, trimmedName);
      setDevices((previous) => sortDeviceSnapshots(previous.map((device) =>
        device.deviceId === response.device.deviceId
          ? response.device
          : device,
      )));
      setInfo('设备名称已更新');
    } catch (reason: unknown) {
      reportError(reason, '更新设备名称失败');
    } finally {
      setDeviceBusy(false);
    }
  }, [api, reportError, setInfo]);

  const revokeDevice = useCallback(async (deviceID: string): Promise<boolean> => {
    setDeviceBusy(true);
    try {
      const response = await api.revokeDevice(deviceID);
      setDevices((previous) => sortDeviceSnapshots(previous.map((device) =>
        device.deviceId === response.device.deviceId
          ? response.device
          : device,
      )));
      setInfo(response.forcedLogout ? '当前设备已撤销' : '设备已撤销');
      return Boolean(response.forcedLogout);
    } catch (reason: unknown) {
      reportError(reason, '撤销设备失败');
      return false;
    } finally {
      setDeviceBusy(false);
    }
  }, [api, reportError, setInfo]);

  const approveDevice = useCallback(async (deviceID: string): Promise<void> => {
    setDeviceBusy(true);
    try {
      const response = await api.approveDevice(deviceID);
      setDevices((previous) => sortDeviceSnapshots(previous.map((device) =>
        device.deviceId === response.device.deviceId
          ? response.device
          : device,
      )));
      if (selectedRoomID && auth) {
        void api.requestDeviceEnvelopeRefill(deviceID, selectedRoomID, [])
          .then((refill) => {
            if (refill.messageIds.length === 0) {
              return;
            }
            sendJSON({
              type: 'envelope_refill_request',
              roomId: selectedRoomID,
              toUserId: auth.user.id,
              toDeviceId: auth.device.deviceId,
              fromUserId: auth.user.id,
              fromUsername: auth.user.username,
              fromDeviceId: deviceID,
              messageIds: refill.messageIds,
            });
          })
          .catch(() => {
            // The approval itself succeeded; the user can retry refill by reopening history.
          });
      }
      setInfo('新设备已批准');
    } catch (reason: unknown) {
      reportError(reason, '批准设备失败');
    } finally {
      setDeviceBusy(false);
    }
  }, [api, auth, reportError, selectedRoomID, sendJSON, setInfo]);

  const saveRecoveryBackup = useCallback(async (phrase: string): Promise<void> => {
    const trimmedPhrase = phrase.trim();
    if (!trimmedPhrase || trimmedPhrase.length < 8) {
      return;
    }
    setDeviceBusy(true);
    try {
      const salt = new Uint8Array(16);
      crypto.getRandomValues(salt);
      const saltText = Array.from(salt).map((value) => value.toString(16).padStart(2, '0')).join('');
      const phraseDigest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${saltText}:${trimmedPhrase}`));
      const digestText = Array.from(new Uint8Array(phraseDigest)).map((value) => value.toString(16).padStart(2, '0')).join('');
      await api.saveDeviceSecretBackup({
        blobVersion: 1,
        kdfSalt: saltText,
        recoveryHint: `sha256:${digestText.slice(0, 12)}`,
        encryptedBlob: {
          kind: 'metadata-only',
          createdAt: new Date().toISOString(),
          note: 'Current device private keys are non-extractable and cannot be exported without a key migration.',
        },
      });
      setInfo('恢复备份元数据已保存');
    } catch (reason: unknown) {
      reportError(reason, '保存恢复备份失败');
    } finally {
      setDeviceBusy(false);
    }
  }, [api, reportError, setInfo]);

  return {
    devices,
    deviceBusy,
    deviceModalOpen,
    openDeviceModal,
    closeDeviceModal,
    refreshDevices,
    renameDevice,
    revokeDevice,
    approveDevice,
    saveRecoveryBackup,
  };
}
