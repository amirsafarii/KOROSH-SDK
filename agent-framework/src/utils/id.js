import { randomUUID } from 'node:crypto';

/**
 * Collision-safe ID factories.
 *
 * IDs use Node's UUID implementation. They are unique without mutating shared
 * run state; event ordering is guaranteed by the EventBus emission order, not
 * by sorting IDs.
 */
export function createId(prefix) {
  return `${prefix}_${randomUUID()}`;
}

export const newRunId = () => createId('run');
export const newTurnId = () => createId('turn');
export const newToolCallId = () => createId('call');
export const newEventId = () => createId('evt');
