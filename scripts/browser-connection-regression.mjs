// Local-only real Chrome/WebRTC regression. No production URL or user profile.
// Run: node --import tsx scripts/browser-connection-regression.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { buildApp } from "../apps/server/src/app.ts";
import { readConfig } from "../apps/server/src/config/app-config.ts";
import { InMemoryRoomStore } from "../apps/server/src/storage/room-store.ts";

const artifacts = await mkdtemp(join(tmpdir(), "peerto-browser-regression-"));
const store = new InMemoryRoomStore({ maxRooms: 100, maxCodes: 100, maxRateBuckets: 100 });
const app = await buildApp({ config: readConfig({ STUN_URLS: "stun:stun.cloudflare.com:3478" }), store, logger: false });
let vite;
let chrome;
const pending = new Map();
const requests = new Map();
const trace = [];
const pageErrors = [];
const acceptedRoles = new Map();
let sequence = 0;
let buffer = "";

function command(method, params = {}, sessionId) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30_000);
    pending.set(id, { resolve, reject, timer });
    chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
  });
}

async function evaluate(sessionId, expression) {
  const result = await command("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}

async function waitFor(sessionId, expression, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  do {
    try {
      if (await evaluate(sessionId, expression)) return;
    } catch (error) {
      // Page.reload can destroy the previous execution context between a poll
      // and its result. Retry only this expected navigation transition.
      if (!/Inspected target navigated or closed|Execution context was destroyed|Cannot find context/.test(String(error))) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  const state = await evaluate(sessionId, `[...document.querySelectorAll('footer,[role="status"],[role="alert"]')].map(node => node.textContent)`);
  throw new Error(`Timed out: ${label}; UI: ${JSON.stringify(state)}; reconnect requests: ${requests.get(sessionId) || 0}; trace: ${JSON.stringify(trace)}`);
}

async function click(sessionId, selector, text) {
  await evaluate(sessionId, `(() => {
    const button = [...document.querySelectorAll(${JSON.stringify(selector)})].find(b => b.textContent.includes(${JSON.stringify(text)}));
    if (!button || button.disabled) throw new Error("Button unavailable");
    button.click();
  })()`);
}

const offlineComposer = `!![...document.querySelectorAll("footer button")].find(b => b.textContent.includes("重试连接")) && !document.querySelector("footer textarea")`;
const onlineComposer = `!!document.querySelector("footer textarea:not(:disabled)")`;
async function snapshot(sessionId, name) {
  const { data } = await command("Page.captureScreenshot", { format: "png" }, sessionId);
  await writeFile(join(artifacts, name + ".png"), Buffer.from(data, "base64"));
}

try {
  const apiOrigin = await app.listen({ host: "127.0.0.1", port: 0 });
  vite = await createServer({
    root: resolve("apps/web"), configFile: resolve("apps/web/vite.config.ts"),
    server: { host: "127.0.0.1", port: 0, proxy: { "/api": { target: apiOrigin, changeOrigin: false }, "/ws": { target: apiOrigin.replace("http:", "ws:"), changeOrigin: false, ws: true } } },
    logLevel: "error",
  });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
  chrome = spawn(process.env.CHROME_BINARY || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", [
    "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-extensions",
    `--user-data-dir=${join(artifacts, "profile")}`, "--remote-debugging-pipe",
  ], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  chrome.on("error", error => {
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    pending.clear();
  });
  chrome.stdio[4].on("data", data => {
    buffer += data.toString();
    let boundary;
    while ((boundary = buffer.indexOf("\0")) >= 0) {
      const raw = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 1);
      if (!raw) continue;
      const message = JSON.parse(raw);
      if (message.method === "Network.webSocketFrameSent") {
        try {
          const frame = JSON.parse(message.params.response.payloadData);
          if (frame.type === "session_init" && frame.recoveryDevice) {
            requests.set(message.sessionId, (requests.get(message.sessionId) || 0) + 1);
          }
        } catch { /* Ignore unrelated sockets. */ }
      }
      if (message.method === "Network.requestWillBeSent" && new URL(message.params.request.url).pathname === "/api/rooms/reconnect") {
        pageErrors.push("Unexpected legacy recovery HTTP request");
      }
      if (message.method === "Runtime.exceptionThrown") pageErrors.push(message.params.exceptionDetails.text);
      if (message.method === "Network.responseReceived" && new URL(message.params.response.url).pathname.startsWith("/api/")) {
        trace.push({ path: new URL(message.params.response.url).pathname, status: message.params.response.status });
      }
      if (message.method === "Network.webSocketFrameReceived") {
        try {
          const frame = JSON.parse(message.params.response.payloadData);
          if (frame.type === "peer_accepted") acceptedRoles.set(message.sessionId, frame.rendezvous.role);
          if (frame.type === "error" || frame.type === "room_closed") trace.push({ type: frame.type, code: frame.code, reason: frame.reason });
        } catch { /* Ignore Vite HMR/non-JSON traffic. */ }
      }
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id); clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result);
    }
  });

  async function browser(name, { fresh = false, url = origin, mobile = false } = {}) {
    const { browserContextId } = await command("Target.createBrowserContext");
    const { targetId } = await command("Target.createTarget", { url: "about:blank", browserContextId });
    const { sessionId } = await command("Target.attachToTarget", { targetId, flatten: true });
    await command("Page.enable", {}, sessionId);
    await command("Runtime.enable", {}, sessionId);
    await command("Network.enable", {}, sessionId);
    await command("Emulation.setDeviceMetricsOverride", { width: mobile ? 390 : 1280, height: 850, deviceScaleFactor: 1, mobile }, sessionId);
    await command("Page.addScriptToEvaluateOnNewDocument", { source: `
      ${fresh ? "" : `document.cookie = "peerto_storage_consent=v1; Path=/; SameSite=Strict";
      localStorage.setItem("peerto-first-device-name-v1", ${JSON.stringify(name)});`}
      localStorage.setItem("peerto-language", "zh");
      window.__peerConnectionsCreated = 0;
      const OriginalPC = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends OriginalPC {
        constructor(...args) { super(...args); window.__peerConnectionsCreated++; }
      };
      const originalSend = WebSocket.prototype.send;
      WebSocket.prototype.send = function(raw) {
        if (String(raw).includes('"authenticate"') && window.__reconnectDelayMs) {
          window.__reconnectResponseHeld = true;
          const socket = this;
          setTimeout(() => { if(socket.readyState === WebSocket.OPEN) originalSend.call(socket, raw); }, window.__reconnectDelayMs);
        } else originalSend.call(this, raw);
      };
    ` }, sessionId);
    await command("Page.navigate", { url }, sessionId);
    if (fresh) return { sessionId, browserContextId };
    await waitFor(sessionId, `!!document.querySelector("main footer textarea") && !!document.querySelector('button[aria-label="生成连接码"]:not(:disabled)')`, "app ready");
    const device = await evaluate(sessionId, `(async () => (await (await import("/src/lib/identity.ts")).loadIdentity(${JSON.stringify(name)})).device)()`);
    return { sessionId, device };
  }

  const a = await browser("Browser A");
  const b = await browser("Browser B");
  for (const current of [a, b]) assert.equal(await evaluate(current.sessionId, "window.__peerConnectionsCreated"), 0, "startup must not create IP-probe connections");
  for (const [current, peer] of [[a, b], [b, a]]) {
    await evaluate(current.sessionId, `(async () => {
      const { useAppStore } = await import("/src/store.ts");
      useAppStore.getState().upsertPeer(${JSON.stringify(peer.device)}, {code:"123456",token:"${"a".repeat(32)}",role:"host"});
    })()`);
    await click(current.sessionId, "nav button", peer.device.name);
    await waitFor(current.sessionId, offlineComposer, "offline composer");
    assert.equal(requests.get(current.sessionId) || 0, 0, "navigation must not reconnect");
  }
  await snapshot(a.sessionId, "offline-desktop");
  await click(a.sessionId, "footer button", "重试连接");
  await waitFor(a.sessionId, `document.querySelector("main > footer").textContent.includes("等待对方")`, "waiting for peer");
  await snapshot(a.sessionId, "waiting-desktop");
  await click(b.sessionId, "footer button", "重试连接");
  await Promise.all([waitFor(a.sessionId, onlineComposer, "A real WebRTC online"), waitFor(b.sessionId, onlineComposer, "B real WebRTC online")]);
  console.log("PASS: opening offline conversations does not connect; both clicks establish real WebRTC");

  const message = "Browser regression message";
  const draft = "Draft survives disconnect";
  async function input(sessionId, text) {
    await evaluate(sessionId, `(() => { const input = document.querySelector("footer textarea");
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(input, ${JSON.stringify(text)});
      input.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  }
  await input(a.sessionId, message);
  await waitFor(a.sessionId, `!!document.querySelector('footer button[aria-label="发送消息"]:not(:disabled)')`, "send ready");
  await evaluate(a.sessionId, `document.querySelector('footer button[aria-label="发送消息"]').click()`);
  await waitFor(b.sessionId, `document.querySelector("main").textContent.includes(${JSON.stringify(message)})`, "peer receives message");
  await input(a.sessionId, draft);

  async function dropAndRestoreBoth() {
    await Promise.all([a, b].map(current => command("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, current.sessionId)));
    await Promise.all([a, b].map(current => waitFor(current.sessionId, offlineComposer, "network offline")));
    await Promise.all([a, b].map(current => command("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, current.sessionId)));
    await Promise.all([a, b].map(current => waitFor(current.sessionId, `!![...document.querySelectorAll("footer button")].find(b => b.textContent.includes("重试连接") && !b.disabled)`, "retry enabled")));
  }
  await dropAndRestoreBoth();
  await evaluate(a.sessionId, `window.dispatchEvent(new Event("pageshow")); document.dispatchEvent(new Event("visibilitychange"));`);
  await click(a.sessionId, "nav button", "我的");
  await click(a.sessionId, "nav button", "Browser B");
  await new Promise(resolve => setTimeout(resolve, 2_000));
  for (const current of [a, b]) {
    assert.equal(await evaluate(current.sessionId, offlineComposer), true);
    assert.equal(requests.get(current.sessionId), 1, "offline/network/navigation must not reconnect");
  }
  await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true }, a.sessionId);
  await snapshot(a.sessionId, "offline-mobile");
  console.log("PASS: real DataChannel messaging; drop, network return, visibility and navigation stay offline");

  await Promise.all([a, b].map(current => click(current.sessionId, "footer button", "重试连接")));
  await Promise.all([a, b].map(current => waitFor(current.sessionId, onlineComposer, "previous path reused")));
  for (const current of [a, b]) assert.equal(requests.get(current.sessionId), 1, "previous path reuse must not create a rendezvous");
  assert.equal(await evaluate(a.sessionId, `document.querySelector("footer textarea").value`), draft);
  console.log("PASS: simultaneous manual retry reuses the real DataChannel with zero new rendezvous requests");
  await dropAndRestoreBoth();

  await click(a.sessionId, "footer button", "重试连接");
  await waitFor(a.sessionId, `document.querySelector("main > footer").textContent.includes("等待对方")`, "manual retry waiting");
  await click(a.sessionId, "footer button", "取消连接");
  await waitFor(a.sessionId, offlineComposer, "cancelled attempt");
  assert.equal(requests.get(a.sessionId), 2);
  await click(a.sessionId, "footer button", "重试连接");
  await waitFor(a.sessionId, `document.querySelector("main > footer").textContent.includes("等待对方")`, "retry after cancel");
  await click(b.sessionId, "footer button", "重试连接");
  await Promise.all([waitFor(a.sessionId, onlineComposer, "A reconnected"), waitFor(b.sessionId, onlineComposer, "B reconnected")]);
  assert.equal(await evaluate(a.sessionId, `document.querySelector("footer textarea").value`), draft);
  await snapshot(a.sessionId, "reconnected-mobile");
  await evaluate(b.sessionId, "window.__regressionBeforeReload = true");
  await command("Page.reload", {}, b.sessionId);
  await waitFor(b.sessionId, `!window.__regressionBeforeReload && !!document.querySelector('button[aria-label="生成连接码"]:not(:disabled)') && [...document.querySelectorAll("nav button")].some(b => b.textContent.includes("Browser A"))`, "reloaded app");
  await click(b.sessionId, "nav button", "Browser A");
  await waitFor(b.sessionId, offlineComposer, "offline after reload");
  assert.equal(requests.get(b.sessionId), 2, "reload must not auto-reconnect");

  async function reloadOffline(current, peer) {
    await evaluate(current.sessionId, "window.__regressionBeforeReload = true");
    await command("Page.reload", {}, current.sessionId);
    await waitFor(current.sessionId, `!window.__regressionBeforeReload && !!document.querySelector('button[aria-label="生成连接码"]:not(:disabled)')`, "fresh page");
    await click(current.sessionId, "nav button", peer.device.name);
    await waitFor(current.sessionId, offlineComposer, "fresh offline conversation");
  }
  for (const mode of ["first-requester-authenticates-last", "b-first", "simultaneous"]) {
    await Promise.all([reloadOffline(a, b), reloadOffline(b, a)]);
    const before = [requests.get(a.sessionId), requests.get(b.sessionId)];
    if (mode === "first-requester-authenticates-last") {
      await evaluate(a.sessionId, "window.__reconnectDelayMs = 1500");
      await click(a.sessionId, "footer button", "重试连接");
      await waitFor(a.sessionId, "window.__reconnectResponseHeld === true", "first socket proof delayed");
      await click(b.sessionId, "footer button", "重试连接");
      await waitFor(b.sessionId, `document.querySelector("main > footer").textContent.includes("等待对方")`, "second socket authenticates first and waits as host");
    } else if (mode === "b-first") {
      await click(b.sessionId, "footer button", "重试连接");
      await waitFor(b.sessionId, `document.querySelector("main > footer").textContent.includes("等待对方")`, "B waiting first");
      await click(a.sessionId, "footer button", "重试连接");
    } else {
      await Promise.all([a, b].map(current => click(current.sessionId, "footer button", "重试连接")));
    }
    await Promise.all([a, b].map(current => waitFor(current.sessionId, onlineComposer, mode + " connected")));
    assert.deepEqual([acceptedRoles.get(a.sessionId), acceptedRoles.get(b.sessionId)].sort(), ["guest", "host"]);
    if (mode === "first-requester-authenticates-last") assert.equal(acceptedRoles.get(a.sessionId), "guest");
    assert.deepEqual([requests.get(a.sessionId), requests.get(b.sessionId)], before.map(count => count + 1));
    console.log("PASS: real WebRTC coordinated recovery: " + mode);
  }

  // Decode the rendered QR, then open the actual URL in an untouched mobile-
  // sized browser context. Consent/name must finish before any room is joined.
  await evaluate(a.sessionId, `document.querySelector('button[aria-label="生成连接码"]').click()`);
  await waitFor(a.sessionId, `!!document.querySelector('[role="dialog"] svg[role="img"]')`, "share QR visible");
  await snapshot(a.sessionId, "share-qr-mobile");
  const invitation = await evaluate(a.sessionId, `(async () => {
    const svg = document.querySelector('[role="dialog"] svg[role="img"]');
    const blob = new Blob([new XMLSerializer().serializeToString(svg)], {type: "image/svg+xml"});
    const url = URL.createObjectURL(blob);
    try {
      const image = new Image(); image.src = url; await image.decode();
      const canvas = document.createElement("canvas"); canvas.width = 832; canvas.height = 832;
      canvas.getContext("2d").drawImage(image, 0, 0, 832, 832);
      const [code] = await new BarcodeDetector({formats: ["qr_code"]}).detect(canvas);
      if (!code) throw new Error("QR decoding failed");
      return code.rawValue;
    } finally { URL.revokeObjectURL(url); }
  })()`);
  assert.equal(new URL(invitation).origin, origin);
  const phone = await browser("", { fresh: true, url: invitation, mobile: true });
  await waitFor(phone.sessionId, `document.body.textContent.includes("Allow local storage") || document.body.textContent.includes("授权本机存储")`, "QR consent gate");
  assert.equal(await evaluate(phone.sessionId, `localStorage.getItem("peerto-first-device-name-v1")`), null);
  assert.equal(await evaluate(phone.sessionId, "location.href"), invitation);
  const chineseBootstrap = await evaluate(phone.sessionId, `navigator.language.toLowerCase().startsWith("zh")`);
  await click(phone.sessionId, "button", chineseBootstrap ? "同意并继续" : "Allow and continue");
  await waitFor(phone.sessionId, `!!document.querySelector("form input")`, "QR device name gate");
  await evaluate(phone.sessionId, "window.__beforeOnboardingReload = true");
  await command("Page.reload", {}, phone.sessionId);
  await waitFor(phone.sessionId, `!window.__beforeOnboardingReload && !!document.querySelector("form input")`, "consent cookie survives onboarding reload");
  assert.equal(await evaluate(phone.sessionId, "location.href"), invitation);
  await evaluate(phone.sessionId, `(() => {
    const input = document.querySelector("form input");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(input,"QR Phone");
    input.dispatchEvent(new Event("input", {bubbles:true}));
  })()`);
  await click(phone.sessionId, "form button", chineseBootstrap ? "进入 Peerto" : "Open Peerto");
  await waitFor(phone.sessionId, `!![...document.querySelectorAll("nav button")].find(b => b.textContent.includes("Browser A")) && ${onlineComposer}`, "QR automatic P2P connection");
  await waitFor(a.sessionId, `!![...document.querySelectorAll("nav button")].find(b => b.textContent.includes("QR Phone")) && ${onlineComposer}`, "host sees chosen phone name");
  assert.equal(await evaluate(phone.sessionId, "location.search + location.hash"), "");
  const phoneIdentity = await evaluate(phone.sessionId, `(async () => (await (await import("/src/lib/identity.ts")).loadIdentity("QR Phone")).device)()`);
  assert.notEqual(phoneIdentity.deviceId, a.device.deviceId);
  await snapshot(phone.sessionId, "qr-phone-connected");
  console.log("PASS: actual QR decoding, fresh mobile consent, reload, naming, automatic connection and independent device identity");

  // Clipboard event payloads with multiple files are staged, not sent. Mixed
  // plain text stays a draft and cancel/removal must never transmit an item.
  const pasteFiles = async () => evaluate(a.sessionId, `(() => {
    const data = new DataTransfer();
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jN2kAAAAASUVORK5CYII="), c => c.charCodeAt(0));
    data.items.add(new File([bytes], "clipboard-shot.png", {type:"image/png"}));
    data.items.add(new File(["clipboard document"], "clipboard-notes.txt", {type:"text/plain"}));
    data.items.add(new File(["remove me"], "remove-me.txt", {type:"text/plain"}));
    data.setData("text/plain", " mixed paste ");
    document.querySelector("footer textarea").dispatchEvent(new ClipboardEvent("paste", {bubbles:true,cancelable:true,clipboardData:data}));
  })()`);
  await pasteFiles();
  await waitFor(a.sessionId, `document.querySelector('[role="dialog"]')?.textContent.includes("发送附件（3）")`, "multi-attachment preview");
  assert.equal(await evaluate(phone.sessionId, `document.querySelector("main").textContent.includes("clipboard-shot.png")`), false);
  await snapshot(a.sessionId, "clipboard-confirm-mobile");
  await click(a.sessionId, '[role="dialog"] button', "取消");
  assert.equal(await evaluate(phone.sessionId, `document.querySelector("main").textContent.includes("clipboard-shot.png")`), false);
  await pasteFiles();
  await waitFor(a.sessionId, `!!document.querySelector('[aria-label="移除 remove-me.txt"]')`, "attachment removal");
  await evaluate(a.sessionId, `document.querySelector('[aria-label="移除 remove-me.txt"]').click()`);
  await waitFor(a.sessionId, `document.querySelector('[role="dialog"]')?.textContent.includes("发送附件（2）")`, "two remaining attachments");
  await click(a.sessionId, '[role="dialog"] button', "发送 2 个文件");
  await waitFor(phone.sessionId, `document.querySelector("main").textContent.includes("clipboard-shot.png") && document.querySelector("main").textContent.includes("clipboard-notes.txt")`, "two files received serially");
  await waitFor(a.sessionId, `(async () => (await import("/src/store.ts")).useAppStore.getState().messages.filter(m => m.conversationId === ${JSON.stringify(phoneIdentity.deviceId)} && m.kind === "file" && m.status === "delivered").length === 2)()`, "sender gets both delivery confirmations");
  assert.equal(await evaluate(phone.sessionId, `document.querySelector("main").textContent.includes("remove-me.txt")`), false);
  assert.equal(await evaluate(a.sessionId, `document.querySelector("footer textarea").value.includes("mixed paste")`), true);
  assert.equal(await evaluate(phone.sessionId, `document.querySelector("main").textContent.includes("mixed paste")`), false);
  assert.equal(await evaluate(a.sessionId, `document.querySelector('input[type="file"]').multiple`), true);
  await evaluate(a.sessionId, `(() => {
    const data = new DataTransfer();
    data.items.add(new File(["picker one"], "picker-one.txt", {type:"text/plain"}));
    data.items.add(new File(["picker two"], "picker-two.txt", {type:"text/plain"}));
    const input = document.querySelector('input[type="file"]');
    input.files = data.files;
    input.dispatchEvent(new Event("change", {bubbles:true}));
  })()`);
  await waitFor(a.sessionId, `document.querySelector('[role="dialog"]')?.textContent.includes("发送附件（2）")`, "fallback multi-file picker confirmation");
  // A navigation while a confirmation is open must never retarget its files.
  await click(a.sessionId, "nav button", "我的");
  await waitFor(a.sessionId, `!document.querySelector('[role="dialog"]')`, "navigation clears unconfirmed attachments");
  assert.equal(await evaluate(phone.sessionId, `document.querySelector("main").textContent.includes("picker-one.txt")`), false);
  await pasteFiles();
  await waitFor(a.sessionId, `document.querySelector('[role="dialog"]')?.textContent.includes("发送附件（3）")`, "saved-message attachments");
  await click(a.sessionId, '[role="dialog"] button', "发送 3 个文件");
  await waitFor(a.sessionId, `(async () => (await import("/src/store.ts")).useAppStore.getState().messages.filter(m => m.kind === "file" && m.status === "local").length === 3)()`, "multiple local attachments saved");
  const { targetId: sameBrowserTab } = await command("Target.createTarget", { url: origin, browserContextId: phone.browserContextId });
  const { sessionId: sameBrowserSession } = await command("Target.attachToTarget", { targetId: sameBrowserTab, flatten: true });
  await waitFor(sameBrowserSession, `!!document.querySelector('button[aria-label="生成连接码"]:not(:disabled)')`, "same-browser new tab reuses consent and name");
  assert.equal(await evaluate(sameBrowserSession, `(async () => (await (await import("/src/lib/identity.ts")).loadIdentity("QR Phone")).device.deviceId)()`), phoneIdentity.deviceId);
  await command("Target.closeTarget", { targetId: sameBrowserTab });
  await evaluate(phone.sessionId, "window.__beforePhoneReload = true");
  await command("Page.reload", {}, phone.sessionId);
  await waitFor(phone.sessionId, `!window.__beforePhoneReload && !!document.querySelector('button[aria-label="生成连接码"]:not(:disabled)')`, "returning phone skips onboarding");
  const restoredIdentity = await evaluate(phone.sessionId, `(async () => (await (await import("/src/lib/identity.ts")).loadIdentity("QR Phone")).device)()`);
  assert.equal(restoredIdentity.deviceId, phoneIdentity.deviceId);
  assert.equal(await evaluate(phone.sessionId, `localStorage.getItem("peerto-first-device-name-v1")`), "QR Phone");
  console.log("PASS: multi-file clipboard/picker preview, cancellation, removal, real serial DataChannel delivery, local saves, navigation isolation, draft preservation and cross-tab identity persistence");
  assert.deepEqual(pageErrors, []);
  console.log("PASS: cancellation and explicit reconnect; original draft restored; no page exceptions");
  console.log(JSON.stringify({ artifacts, reconnectRequests: { a: requests.get(a.sessionId), b: requests.get(b.sessionId) }, scope: "isolated desktop/mobile-sized Chrome contexts on the same Mac; not physical-phone or cross-NAT acceptance" }, null, 2));
} finally {
  for (const waiter of pending.values()) clearTimeout(waiter.timer);
  pending.clear();
  chrome?.kill("SIGTERM");
  await vite?.close();
  await app.close();
}
