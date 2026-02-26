import { useMemo } from 'react';
import type { Identity } from '../../crypto';

type FailedQueueItem = {
  id: string;
  text: string;
  lastError: string | null;
};

type UseChatRouteViewModelArgs = {
  wsConnected: boolean;
  reconnectCountdownSec: number | null;
  identity: Identity | null;
  failedQueueItems: FailedQueueItem[];
  roomSearchQuery: string;
  roomSearchMatches: number[];
  activeSearchResultIndex: number;
  hasMoreHistory: boolean;
};

export function useChatRouteViewModel({
  wsConnected,
  reconnectCountdownSec,
  identity,
  failedQueueItems,
  roomSearchQuery,
  roomSearchMatches,
  activeSearchResultIndex,
  hasMoreHistory,
}: UseChatRouteViewModelArgs) {
  const wsStateText = wsConnected
    ? 'SECURE LINK ONLINE'
    : reconnectCountdownSec !== null
      ? `正在尝试重新连接 (${reconnectCountdownSec}s)...`
      : 'SECURE LINK OFFLINE';

  const wsStateClass = wsConnected
    ? 'online'
    : reconnectCountdownSec !== null
      ? 'reconnecting'
      : 'offline';

  const localKeyVersions = identity?.privateKeys.length ?? 0;

  const failedQueueViewItems = useMemo(
    () =>
      failedQueueItems.map((item) => ({
        id: item.id,
        text: item.text,
        lastError: item.lastError,
      })),
    [failedQueueItems],
  );

  const roomSearchMetaText = roomSearchQuery.trim()
    ? roomSearchMatches.length > 0
      ? `${activeSearchResultIndex + 1}/${roomSearchMatches.length}`
      : hasMoreHistory
        ? '未匹配，继续上滑加载'
        : '无匹配结果'
    : '';

  return {
    wsStateText,
    wsStateClass,
    localKeyVersions,
    failedQueueViewItems,
    roomSearchMetaText,
  };
}
