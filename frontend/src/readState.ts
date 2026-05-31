import { parseRecipientAddress } from './crypto/utils';

export function collectExpectedReadUserIDs(
  wrappedKeys: Record<string, unknown> | undefined,
  senderUserID: number,
): number[] {
  const recipientUserIDs = new Set<number>();
  for (const address of Object.keys(wrappedKeys ?? {})) {
    const recipient = parseRecipientAddress(address);
    if (!recipient || recipient.userID === senderUserID) {
      continue;
    }
    recipientUserIDs.add(recipient.userID);
  }
  return [...recipientUserIDs].sort((left, right) => left - right);
}

export function countExpectedReadUsers(
  wrappedKeys: Record<string, unknown> | undefined,
  senderUserID: number,
): number {
  return collectExpectedReadUserIDs(wrappedKeys, senderUserID).length;
}

export function isExpectedReadUser(
  wrappedKeys: Record<string, unknown> | undefined,
  senderUserID: number,
  userID: number,
): boolean {
  if (!Number.isFinite(userID) || userID <= 0 || userID === senderUserID) {
    return false;
  }
  return collectExpectedReadUserIDs(wrappedKeys, senderUserID).includes(userID);
}
