import { afterEach, describe, expect, it, vi } from "vitest";
import { consumeSharedJoin, sharedJoinFromLocation, shareUrl } from "./share-link";

const token = "a".repeat(32);
function location(url: string) {
  const browser = { location: new URL(url), history: { state: { existing: true }, replaceState: vi.fn() } };
  vi.stubGlobal("window", browser);
  return browser;
}
afterEach(() => vi.unstubAllGlobals());

describe("QR/share invitations", () => {
  it("survives repeated render reads and consent/name onboarding without side effects", () => {
    const browser = location(`https://peerto.test/?join=123456#token=${token}`);
    expect(sharedJoinFromLocation()).toEqual({ code: "123456", token });
    expect(sharedJoinFromLocation()).toEqual({ code: "123456", token });
    expect(browser.history.replaceState).not.toHaveBeenCalled();
  });
  it("consumes only its own invitation, preserving other navigation state", () => {
    const browser = location(`https://peerto.test/?join=123456&lang=zh#token=${token}&tab=chat`);
    consumeSharedJoin({ code: "654321", token });
    expect(browser.history.replaceState).not.toHaveBeenCalled();
    consumeSharedJoin({ code: "123456", token });
    expect(browser.history.replaceState).toHaveBeenCalledExactlyOnceWith({ existing: true }, "", "/?lang=zh#tab=chat");
  });
  it("uses the same origin and puts only the one-time invitation token in the fragment", () => {
    location("https://peerto.test/");
    const url = new URL(shareUrl({ code: "123456", expiresAt: Date.now() + 1000, shareToken: token }));
    expect(url.origin).toBe("https://peerto.test");
    expect(url.search).toBe("?join=123456");
    expect(url.hash).toBe(`#token=${token}`);
    expect(sharedJoinFromLocation()).toBeUndefined();
  });
  it.each(["short", "x".repeat(257), "a".repeat(32) + "%20bad"])("rejects malformed tokens", invalid => {
    location(`https://peerto.test/?join=123456#token=${invalid}`);
    expect(sharedJoinFromLocation()).toBeUndefined();
  });
});
