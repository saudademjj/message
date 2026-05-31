import { useEffect, useRef } from 'react';

type UseSessionScopedResetArgs = {
  // The currently authenticated user id, or null when signed out.
  authUserID: number | null;
  // Clears all session-scoped Zustand store state (messages, sendQueue,
  // localDraftMessages, messageReadReceipts, peers, rooms, members, etc).
  resetSessionScopedState: () => void;
};

/**
 * Centrally clears session-scoped store state whenever the authenticated user
 * goes away (forced logout via WebSocket close codes / session-probe expiry) or
 * changes to a different account within the same tab.
 *
 * Forced-logout paths only call AuthContext.logout(), which clears `auth` but
 * not the Zustand store. Without this, the previous account's decrypted
 * messages, drafts, queues and peers would leak into the next login in the same
 * tab. The manual logout button still resets explicitly; this hook covers every
 * other transition.
 *
 * It tracks the previously-seen user id in a ref and never resets on the very
 * first observation, so a normal fresh login does not wipe freshly loaded data.
 * The reset only fires when transitioning away from a known user id (to null or
 * to a different id), which makes it idempotent and loop-free.
 */
export function useSessionScopedReset({
  authUserID,
  resetSessionScopedState,
}: UseSessionScopedResetArgs): void {
  // `undefined` means "no user id observed yet" (first mount); `null` means we
  // have observed a signed-out state.
  const previousUserIDRef = useRef<number | null | undefined>(undefined);

  useEffect(() => {
    const previousUserID = previousUserIDRef.current;
    previousUserIDRef.current = authUserID;

    if (previousUserID === undefined) {
      // First observation (initial mount or first auth resolution): never reset.
      return;
    }
    if (previousUserID === null) {
      // Transition from signed-out to signed-in (a normal login): nothing to clear.
      return;
    }
    if (previousUserID === authUserID) {
      return;
    }
    // The previously authenticated user went away or changed: clear the store so
    // no prior-account state leaks into the next session.
    resetSessionScopedState();
  }, [authUserID, resetSessionScopedState]);
}
