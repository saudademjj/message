import type { ApiClient } from '../../api';

export type ChatRoutePageProps = {
  api: ApiClient;
  routeMode: 'chat' | 'admin';
  roomIDFromRoute: number | null;
};
