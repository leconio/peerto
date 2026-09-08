import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeRoom } from "./runtime-room";
import { markSignalingStable, releaseRuntime, retainConsumedSignaling, SIGNALING_STABILIZATION_MS } from "./signaling-retention";

vi.mock("./socket-utils", () => ({ closeSocket: (socket: { close(): void }) => socket.close() }));
afterEach(() => vi.useRealTimers());

function room() {
  return { roomId: "room", roomKey: "pair", consumed: true, host: { socket: { close: vi.fn() } }, guest: { socket: { close: vi.fn() } }, expiryTimer: setTimeout(() => {}, 300_000) } as unknown as RuntimeRoom;
}

describe("consumed signaling stabilization", () => {
  it("releases early only when both authenticated members are ready", () => {
    vi.useFakeTimers();
    const runtime = room(); const rooms = new Map([[runtime.roomKey, runtime]]);
    retainConsumedSignaling(rooms, runtime);
    markSignalingStable(rooms, runtime, room().host);
    markSignalingStable(rooms, runtime, runtime.host);
    expect(rooms.size).toBe(1);
    markSignalingStable(rooms, runtime, runtime.guest!);
    expect(rooms.size).toBe(0);
    expect(runtime.host.socket.close).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(SIGNALING_STABILIZATION_MS);
    expect(runtime.host.socket.close).toHaveBeenCalledOnce();
  });
  it("ignores early readiness before both peers report connected", () => {
    vi.useFakeTimers();
    const runtime = room(); runtime.consumed = false;
    const rooms = new Map([[runtime.roomKey, runtime]]);
    markSignalingStable(rooms, runtime, runtime.host);
    markSignalingStable(rooms, runtime, runtime.guest!);
    expect(rooms.size).toBe(1);
    expect(runtime.host.signalingStable).toBeUndefined();
  });
  it("releases both sockets after a bounded grace period", () => {
    vi.useFakeTimers();
    const runtime = room();
    const rooms = new Map([[runtime.roomKey, runtime]]);
    retainConsumedSignaling(rooms, runtime);
    vi.advanceTimersByTime(SIGNALING_STABILIZATION_MS - 1);
    expect(runtime.host.socket.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(runtime.host.socket.close).toHaveBeenCalledOnce();
    expect(runtime.guest!.socket.close).toHaveBeenCalledOnce();
    expect(rooms.size).toBe(0);
  });

  it("does not let an old timer remove a replacement runtime", () => {
    vi.useFakeTimers();
    const old = room();
    const rooms = new Map([[old.roomKey, old]]);
    retainConsumedSignaling(rooms, old);
    const next = room();
    rooms.set(next.roomKey, next);
    vi.advanceTimersByTime(SIGNALING_STABILIZATION_MS);
    expect(rooms.get(next.roomKey)).toBe(next);
    expect(next.host.socket.close).not.toHaveBeenCalled();
    releaseRuntime(rooms, next);
  });

  it("cleans the timer on early close and is idempotent", () => {
    vi.useFakeTimers();
    const runtime = room();
    const rooms = new Map([[runtime.roomKey, runtime]]);
    retainConsumedSignaling(rooms, runtime);
    releaseRuntime(rooms, runtime);
    releaseRuntime(rooms, runtime);
    expect(vi.getTimerCount()).toBe(0);
    expect(runtime.host.socket.close).toHaveBeenCalledOnce();
  });
});
