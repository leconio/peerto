import {
  clientWsMessageSchema,
  type ClientWsMessage,
  wsSessionInitSchema,
  type ServerWsMessage,
  type WsSessionInit,
} from "@peerto/protocol";
import { WebSocket, type RawData } from "ws";

const SESSION_INIT_TIMEOUT_MS = 10_000;

/** One bounded, ordered message queue per socket, including async storage. */
export function listenMessages(
  socket: WebSocket,
  acceptMessage: (socket: WebSocket) => boolean,
  handle: (message: ClientWsMessage) => Promise<void>,
): void {
  let queue = Promise.resolve();
  socket.on("message", raw => {
    if (socket.readyState !== WebSocket.OPEN || !acceptMessage(socket)) return;
    queue = queue.then(async () => {
      if (socket.readyState !== WebSocket.OPEN) return;
      let json: unknown;
      try { json = JSON.parse(raw.toString()); }
      catch {
        closeWithMessage(socket, { type: "error", code: "INVALID_JSON", message: "无效信令" });
        return;
      }
      const parsed = clientWsMessageSchema.safeParse(json);
      if (!parsed.success) {
        closeWithMessage(socket, { type: "error", code: "INVALID_MESSAGE", message: "无效信令" });
        return;
      }
      await handle(parsed.data);
    }).catch(() => closeWithMessage(socket, {
      type: "error", code: "SIGNALING_UNAVAILABLE", message: "信令暂时不可用",
    }));
  });
}

export function send(
  socket: WebSocket,
  message: ServerWsMessage,
): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

export function closeSocket(socket: WebSocket, code = 1000): void {
  if (
    socket.readyState === WebSocket.CLOSED ||
    socket.readyState === WebSocket.CLOSING
  ) {
    return;
  }
  socket.close(code);
  const terminationTimer = setTimeout(() => {
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
  }, 2_000);
  terminationTimer.unref();
  socket.once("close", () => clearTimeout(terminationTimer));
}

export function closeWithMessage(
  socket: WebSocket,
  message: ServerWsMessage,
  code = 1008,
): void {
  send(socket, message);
  closeSocket(socket, code);
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function receiveSessionInit(
  socket: WebSocket,
): Promise<WsSessionInit | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(undefined);
    }, SESSION_INIT_TIMEOUT_MS);
    const onMessage = (raw: RawData) => {
      cleanup();
      try {
        const parsed = wsSessionInitSchema.safeParse(
          JSON.parse(raw.toString()),
        );
        resolve(parsed.success ? parsed.data : undefined);
      } catch {
        resolve(undefined);
      }
    };
    const onClose = () => {
      cleanup();
      resolve(undefined);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("close", onClose);
    };
    socket.once("message", onMessage);
    socket.once("close", onClose);
  });
}
