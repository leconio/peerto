import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SignalingHandover } from "./signaling-handover";

beforeEach(() => { vi.useFakeTimers(); vi.stubGlobal("window", { setTimeout, clearTimeout }); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function setup() {
  const actions = { ready: vi.fn(() => true), nextNonce: () => 123, ping: vi.fn(() => true), release: vi.fn() };
  return { actions, handover: new SignalingHandover(actions) };
}
describe("signaling handover", () => {
  it("requires a settling period and matching fresh data-channel pong", () => {
    const { actions, handover } = setup();
    handover.update(); handover.update();
    vi.advanceTimersByTime(2_999); expect(actions.ping).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(actions.ping).toHaveBeenCalledOnce();
    handover.pong(122); expect(actions.release).not.toHaveBeenCalled();
    handover.pong(123); expect(actions.release).toHaveBeenCalledOnce();
    handover.update(); vi.advanceTimersByTime(30_000);
    expect(actions.release).toHaveBeenCalledOnce();
  });
  it.each(["settling", "probing"])("keeps the fallback lease when ICE becomes unstable while %s", phase => {
    const { actions, handover } = setup(); handover.update();
    if (phase === "probing") vi.advanceTimersByTime(3_000);
    actions.ready.mockReturnValue(false); handover.update(); handover.pong(123);
    vi.advanceTimersByTime(30_000); expect(actions.release).not.toHaveBeenCalled();
  });
  it("does not release on a timed-out or cancelled pong", () => {
    const { actions, handover } = setup(); handover.update();
    vi.advanceTimersByTime(8_000); handover.pong(123);
    expect(actions.release).not.toHaveBeenCalled();
    handover.update(); vi.advanceTimersByTime(3_000); handover.reset(); handover.pong(123);
    expect(actions.release).not.toHaveBeenCalled();
  });
});
