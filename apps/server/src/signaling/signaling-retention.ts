import type { ConnectedSocket, RuntimeRoom, RuntimeRoomMap } from "./runtime-room";
import type { RoomStore } from "../storage/room-store";
import { closeSocket, send } from "./socket-utils";

export const SIGNALING_STABILIZATION_MS = 30_000;

export function markSignalingStable(rooms: RuntimeRoomMap, runtime: RuntimeRoom, member: ConnectedSocket): void {
  if (rooms.get(runtime.roomKey) !== runtime || !runtime.consumed ||
      (member !== runtime.host && member !== runtime.guest)) return;
  member.signalingStable = true;
  if (runtime.host.signalingStable && runtime.guest?.signalingStable) releaseRuntime(rooms, runtime);
}

export function consumeRoom(store: RoomStore, rooms: RuntimeRoomMap, code: string, runtime: RuntimeRoom): void {
  if (rooms.get(runtime.roomKey) !== runtime || runtime.consumed || !runtime.accepted ||
      !runtime.hostConnected || !runtime.guestConnected) return;
  runtime.consumed = true;
  void store.deleteRoom(code, runtime.roomKey, runtime.roomId);
  send(runtime.host.socket, { type: "room_consumed" });
  if (runtime.guest) send(runtime.guest.socket, { type: "room_consumed" });
  retainConsumedSignaling(rooms, runtime);
}

export function releaseRuntime(runtimeRooms: RuntimeRoomMap, runtime: RuntimeRoom): void {
  clearTimeout(runtime.expiryTimer);
  if (runtimeRooms.get(runtime.roomKey) !== runtime) return;
  runtimeRooms.delete(runtime.roomKey);
  closeSocket(runtime.host.socket);
  if (runtime.guest) closeSocket(runtime.guest.socket);
}

export function retainConsumedSignaling(runtimeRooms: RuntimeRoomMap, runtime: RuntimeRoom): void {
  clearTimeout(runtime.expiryTimer);
  // The joinable room is already deleted. Only this authenticated socket pair
  // can exchange late candidates and ICE restarts during stabilization.
  runtime.expiryTimer = setTimeout(() => releaseRuntime(runtimeRooms, runtime), SIGNALING_STABILIZATION_MS);
  runtime.expiryTimer.unref();
}
