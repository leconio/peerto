import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { WebSocket } from "ws";

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:3000";

function stablePublicKey(publicKey) {
  return JSON.stringify({
    crv: publicKey.crv,
    kty: publicKey.kty,
    x: publicKey.x,
    y: publicKey.y,
  });
}

function createDevice(name) {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  const jwk = publicKey.export({ format: "jwk" });
  return {
    privateKey,
    identity: {
      deviceId: createHash("sha256")
        .update(stablePublicKey(jwk))
        .digest("base64url"),
      name,
      publicKey: {
        crv: "P-256",
        kty: "EC",
        x: jwk.x,
        y: jwk.y,
      },
    },
  };
}

class MessageSocket {
  #queue = [];
  #waiters = [];

  constructor(url) {
    this.socket = new WebSocket(url);
    this.socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      const waiter = this.#waiters.shift();
      if (waiter) waiter.resolve(message);
      else this.#queue.push(message);
    });
  }

  async open(init = { type: "session_init" }) {
    if (this.socket.readyState !== WebSocket.OPEN) {
      await new Promise((resolve, reject) => {
        this.socket.once("open", resolve);
        this.socket.once("error", reject);
      });
    }
    this.send(init);
  }

  next(expectedType) {
    const queued = this.#queue.shift();
    if (queued) return this.#assertType(queued, expectedType);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`等待 ${expectedType} 超时`)),
        5_000,
      );
      this.#waiters.push({
        resolve: (message) => {
          clearTimeout(timer);
          try {
            resolve(this.#assertType(message, expectedType));
          } catch (error) {
            reject(error);
          }
        },
      });
    });
  }

  #assertType(message, expectedType) {
    if (message.type !== expectedType) {
      throw new Error(
        `期望 ${expectedType}，实际收到 ${message.type}: ${JSON.stringify(message)}`,
      );
    }
    return message;
  }

  send(message) {
    this.socket.send(JSON.stringify(message));
  }

  close() {
    this.socket.close();
  }
}

async function authenticateHost(socket, device, code) {
  const challenge = await socket.next("challenge");
  const signature = sign(
    "sha256",
    Buffer.from(`peerto:${code}:${challenge.challenge}`, "utf8"),
    {
      key: device.privateKey,
      dsaEncoding: "ieee-p1363",
    },
  ).toString("base64url");
  socket.send({
    type: "authenticate",
    device: device.identity,
    signature,
  });
  await socket.next("room_ready");
}

const healthResponse = await fetch(`${baseUrl}/api/health`);
if (!healthResponse.ok) throw new Error("健康检查失败");

const hostDevice = createDevice("Acceptance Host");
const guestDevice = createDevice("Acceptance Guest");
const roomResponse = await fetch(`${baseUrl}/api/rooms`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ host: hostDevice.identity }),
});
if (roomResponse.status !== 201) {
  throw new Error(`创建连接码失败: ${await roomResponse.text()}`);
}
const room = await roomResponse.json();
if (!/^\d{6}$/.test(room.code)) throw new Error("连接码格式无效");

const wsBase = baseUrl.replace(/^http/, "ws");
const host = new MessageSocket(
  `${wsBase}/ws?role=host&code=${room.code}`,
);
await host.open({
  type: "session_init",
  token: room.hostToken,
  connectionToken: room.connectionToken,
});
await authenticateHost(host, hostDevice, room.code);

const guest = new MessageSocket(
  `${wsBase}/ws?role=guest&code=${room.code}`,
);
await guest.open();
const challenge = await guest.next("challenge");
const payload = Buffer.from(
  `peerto:${room.code}:${challenge.challenge}`,
  "utf8",
);
const signature = sign("sha256", payload, {
  key: guestDevice.privateKey,
  dsaEncoding: "ieee-p1363",
}).toString("base64url");
guest.send({
  type: "authenticate",
  device: guestDevice.identity,
  signature,
});

await host.next("join_request");
host.send({
  type: "accept_peer",
  deviceId: guestDevice.identity.deviceId,
});
await host.next("peer_accepted");
await guest.next("peer_accepted");

const candidateSignal = {
  type: "signal",
  signal: {
    kind: "candidate",
    candidate: {
      candidate:
        "candidate:1 1 UDP 2122260223 192.0.2.1 50000 typ host",
      sdpMid: "0",
      sdpMLineIndex: 0,
    },
  },
};
host.send(candidateSignal);
await guest.next("signal");
guest.send(candidateSignal);
await host.next("signal");

guest.send({
  type: "signal",
  signal: { kind: "restart_request" },
});
const restartRequest = await host.next("signal");
if (restartRequest.signal.kind !== "restart_request") {
  throw new Error("ICE restart 请求未被转发");
}

host.send({ type: "connected" });
guest.send({ type: "connected" });
await host.next("room_consumed");
await guest.next("room_consumed");

host.close();
guest.close();

const reconnectHostResponse = await fetch(
  `${baseUrl}/api/rooms/reconnect`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: room.code,
      device: hostDevice.identity,
      peerDeviceId: guestDevice.identity.deviceId,
      connectionToken: room.connectionToken,
    }),
  },
);
if (!reconnectHostResponse.ok) {
  throw new Error(`自动恢复登记失败: ${await reconnectHostResponse.text()}`);
}
const reconnectHostRoom = await reconnectHostResponse.json();
if (reconnectHostRoom.role !== "host") {
  throw new Error("首个自动恢复设备未成为 Host");
}
const recoveryHost = new MessageSocket(
  `${wsBase}/ws?role=host&code=${room.code}`,
);
await recoveryHost.open({
  type: "session_init",
  token: room.connectionToken,
  connectionToken: room.connectionToken,
  deviceId: hostDevice.identity.deviceId,
  peerDeviceId: guestDevice.identity.deviceId,
});
await authenticateHost(recoveryHost, hostDevice, room.code);

const reconnectGuestResponse = await fetch(
  `${baseUrl}/api/rooms/reconnect`,
  {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code: room.code,
      device: guestDevice.identity,
      peerDeviceId: hostDevice.identity.deviceId,
      connectionToken: room.connectionToken,
    }),
  },
);
if (!reconnectGuestResponse.ok) {
  throw new Error(`自动恢复加入失败: ${await reconnectGuestResponse.text()}`);
}
const reconnectGuestRoom = await reconnectGuestResponse.json();
if (reconnectGuestRoom.role !== "guest") {
  throw new Error("第二个自动恢复设备未成为 Guest");
}
const recoveryGuest = new MessageSocket(
  `${wsBase}/ws?role=guest&code=${room.code}`,
);
await recoveryGuest.open({
  type: "session_init",
  connectionToken: room.connectionToken,
  deviceId: guestDevice.identity.deviceId,
  peerDeviceId: hostDevice.identity.deviceId,
});
const recoveryChallenge = await recoveryGuest.next("challenge");
const recoverySignature = sign(
  "sha256",
  Buffer.from(
    `peerto:${room.code}:${recoveryChallenge.challenge}`,
    "utf8",
  ),
  {
    key: guestDevice.privateKey,
    dsaEncoding: "ieee-p1363",
  },
).toString("base64url");
recoveryGuest.send({
  type: "authenticate",
  device: guestDevice.identity,
  signature: recoverySignature,
  connectionToken: room.connectionToken,
});
await recoveryHost.next("peer_accepted");
await recoveryGuest.next("peer_accepted");
recoveryHost.send({ type: "connected" });
recoveryGuest.send({ type: "connected" });
await recoveryHost.next("room_consumed");
await recoveryGuest.next("room_consumed");
recoveryHost.close();
recoveryGuest.close();

const reused = new MessageSocket(
  `${wsBase}/ws?role=guest&code=${room.code}`,
);
await reused.open();
const closed = await reused.next("room_closed");
reused.close();
if (closed.reason !== "invalid_code") {
  throw new Error(`连接码未正确销毁: ${closed.reason}`);
}

const sharedResponse = await fetch(`${baseUrl}/api/rooms`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ host: hostDevice.identity }),
});
if (sharedResponse.status !== 201) {
  throw new Error(`创建分享连接失败: ${await sharedResponse.text()}`);
}
const sharedRoom = await sharedResponse.json();
if (
  typeof sharedRoom.shareToken !== "string" ||
  sharedRoom.shareToken.length < 32
) {
  throw new Error("分享链接凭证格式无效");
}
const sharedHost = new MessageSocket(
  `${wsBase}/ws?role=host&code=${sharedRoom.code}`,
);
await sharedHost.open({
  type: "session_init",
  token: sharedRoom.hostToken,
  connectionToken: sharedRoom.connectionToken,
});
await authenticateHost(sharedHost, hostDevice, sharedRoom.code);
const sharedGuest = new MessageSocket(
  `${wsBase}/ws?role=guest&code=${sharedRoom.code}`,
);
await sharedGuest.open();
const sharedChallenge = await sharedGuest.next("challenge");
const sharedPayload = Buffer.from(
  `peerto:${sharedRoom.code}:${sharedChallenge.challenge}`,
  "utf8",
);
const sharedSignature = sign("sha256", sharedPayload, {
  key: guestDevice.privateKey,
  dsaEncoding: "ieee-p1363",
}).toString("base64url");
sharedGuest.send({
  type: "authenticate",
  device: guestDevice.identity,
  signature: sharedSignature,
  shareToken: sharedRoom.shareToken,
});
await sharedHost.next("peer_accepted");
await sharedGuest.next("peer_accepted");
sharedHost.send({ type: "connected" });
sharedGuest.send({ type: "connected" });
await sharedHost.next("room_consumed");
await sharedGuest.next("room_consumed");
sharedHost.close();
sharedGuest.close();

console.log(
  JSON.stringify(
    {
      health: "ok",
      codeFormat: "ok",
      deviceProof: "ok",
      hostApproval: "ok",
      bidirectionalSignaling: "ok",
      temporarySignalingClosed: "ok",
      automaticReconnect: "ok",
      singleUseCode: "ok",
      shareLinkAutoConnect: "ok",
    },
    null,
    2,
  ),
);
