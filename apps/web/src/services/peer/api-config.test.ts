import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadApiConfig } from "./api-config";
import { fetchJson } from "./fetch-json";

const config = { iceServers: [{ urls: "stun:test.invalid" }], maxFileBytes: 100, roomTtlSeconds: 30 };

describe("bounded config and room requests", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("window", { setTimeout, clearTimeout });
    vi.stubGlobal("localStorage", { getItem: vi.fn(() => null), setItem: vi.fn() });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(["headers", "body"])("falls back to cached config when %s stall", async (phase) => {
    const stalled = new Promise<Response>(() => {});
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => phase === "headers"
      ? stalled
      : { ok: true, json: () => stalled });
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(localStorage.getItem).mockReturnValue(JSON.stringify(config));
    const pending = loadApiConfig();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await pending).toEqual(config);
    expect(fetchMock.mock.calls[0]?.[1].signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["unavailable", "corrupt", "invalid"])("uses defaults if storage is %s", async (state) => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    vi.mocked(localStorage.getItem).mockImplementation(() => {
      if (state === "unavailable") throw new Error("storage denied");
      return state === "corrupt" ? "{" : JSON.stringify({ iceServers: [] });
    });
    const result = await loadApiConfig();
    expect(result.iceServers.length).toBeGreaterThan(0);
    expect(result.roomTtlSeconds).toBe(300);
  });

  it("keeps a valid network response when caching is denied", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(config)));
    vi.mocked(localStorage.setItem).mockImplementation(() => { throw new Error("quota"); });
    expect(await loadApiConfig()).toEqual(config);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects malformed network configuration before it reaches WebRTC", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...config, iceServers: [null] })));
    vi.mocked(localStorage.getItem).mockReturnValue(JSON.stringify(config));
    expect(await loadApiConfig()).toEqual(config);
    expect(localStorage.setItem).not.toHaveBeenCalled();
  });

  it("aborts a stalled request and releases its timer on caller cancellation", async () => {
    const fetchMock = vi.fn((_url: string, _init: RequestInit) => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const pending = fetchJson("/api/rooms", { signal: controller.signal }, 10_000);
    const result = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    controller.abort();
    await result;
    expect(fetchMock.mock.calls[0]?.[1].signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not issue an already cancelled request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort();
    await expect(fetchJson("/api/rooms", { signal: controller.signal }, 10_000))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
