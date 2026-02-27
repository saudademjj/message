import { ApiError } from '../api';
import { classifySessionProbeFailure, computeReconnectDelaySeconds } from './WebSocketContext';

describe('WebSocket reconnect guards', () => {
  it('classifies 401/403 probe failures as expired auth', () => {
    expect(classifySessionProbeFailure(new ApiError('http', 'unauthorized', 401))).toBe('expired');
    expect(classifySessionProbeFailure(new ApiError('http', 'forbidden', 403))).toBe('expired');
  });

  it('classifies non-auth failures as retry', () => {
    expect(classifySessionProbeFailure(new ApiError('network', 'network request failed'))).toBe('retry');
    expect(classifySessionProbeFailure(new Error('unknown'))).toBe('retry');
  });

  it('computes bounded reconnect delay with jitter and cap', () => {
    expect(computeReconnectDelaySeconds(0, 0)).toBe(2);
    expect(computeReconnectDelaySeconds(0, 1)).toBe(4);
    expect(computeReconnectDelaySeconds(10, 0)).toBe(24);
    expect(computeReconnectDelaySeconds(10, 1)).toBe(36);
  });
});
