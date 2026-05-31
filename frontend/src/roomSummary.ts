import type { Room } from './types';

function roomActivityValue(room: Room): number {
  const parsed = Date.parse(room.lastActivityAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function sortRoomsByActivity(rooms: Room[]): Room[] {
  return [...rooms].sort((left, right) => {
    const activityDelta = roomActivityValue(right) - roomActivityValue(left);
    if (activityDelta !== 0) {
      return activityDelta;
    }
    return right.id - left.id;
  });
}

export function replaceRoomSummaries(nextRooms: Room[]): Room[] {
  return sortRoomsByActivity(nextRooms);
}

export function mergeRoomSummary(previous: Room[], summary: Room): Room[] {
  const index = previous.findIndex((room) => room.id === summary.id);
  if (index === -1) {
    return sortRoomsByActivity([...previous, summary]);
  }
  const next = [...previous];
  next[index] = summary;
  return sortRoomsByActivity(next);
}
