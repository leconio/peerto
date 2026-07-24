export interface HostRoomLease {
  code: string;
  expiresAt: number;
}

export function canReuseHostRoom(
  room: HostRoomLease | undefined,
  activeHostCode: string | undefined,
  now = Date.now(),
): boolean {
  return Boolean(
    room &&
      room.code === activeHostCode &&
      room.expiresAt > now,
  );
}
