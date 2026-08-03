import type { ReplayData } from './replay-data';

export interface PendingSupersession {
  readonly retiredObjectId: string;
  readonly replacementObjectId: string;
  readonly clientSupersessionId: string;
}

/** Reuse a durable request only when both semantic endpoints are identical. */
export function retainedSupersessionKey(
  pending: PendingSupersession | null,
  retiredObjectId: string,
  replacementObjectId: string,
): string | undefined {
  return pending?.retiredObjectId === retiredObjectId &&
    pending.replacementObjectId === replacementObjectId
    ? pending.clientSupersessionId
    : undefined;
}

/** The persisted fold, not an ack, decides when a pending action is complete. */
export function supersessionReachedFold(
  objects: ReplayData['objects'],
  pending: PendingSupersession | null,
): boolean {
  if (!pending) return false;
  return (
    objects.find((object) => object.id === pending.retiredObjectId)?.supersededById ===
    pending.replacementObjectId
  );
}
