import type { DeviceIdentity } from "@peerto/protocol";
import type { WebSocket } from "ws";

export interface ConnectedSocket {
  socket: WebSocket;
  ip: string;
  isAlive: boolean;
  device?: DeviceIdentity;
}

export interface RuntimeRoom {
  roomKey: string;
  tokenHash: string;
  host: ConnectedSocket;
  guest: ConnectedSocket | undefined;
  guestIp: string | undefined;
  accepted: boolean;
  hostAuthenticated: boolean;
  hostConnected: boolean;
  guestConnected: boolean;
  consumed: boolean;
  connectionToken: string;
  expiresAt: number;
  expiryTimer: NodeJS.Timeout;
}

export type RuntimeRoomMap = Map<string, RuntimeRoom>;
