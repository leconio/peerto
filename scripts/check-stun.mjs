import dgram from "node:dgram";
import { lookup } from "node:dns/promises";
import { randomBytes } from "node:crypto";

const hosts = (
  process.env.STUN_HOSTS ||
  "stun.miwifi.com,stun.chat.bilibili.com,stun.hitv.com"
)
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);
const port = Number(process.env.STUN_PORT || 3478);

async function probe(address, family) {
  const transaction = randomBytes(12);
  const request = Buffer.alloc(20);
  request.writeUInt16BE(0x0001, 0);
  request.writeUInt16BE(0, 2);
  request.writeUInt32BE(0x2112a442, 4);
  transaction.copy(request, 8);
  const socket = dgram.createSocket(family === 6 ? "udp6" : "udp4");

  try {
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        socket.close();
        resolve({ address, family, status: "timeout" });
      }, 2_500);
      socket.once("error", (error) => {
        clearTimeout(timer);
        socket.close();
        resolve({
          address,
          family,
          status: "error",
          detail: error.code || error.message,
        });
      });
      socket.once("message", (response, remote) => {
        clearTimeout(timer);
        socket.close();
        const valid =
          response.length >= 20 &&
          response.readUInt16BE(0) === 0x0101 &&
          response.subarray(8, 20).equals(transaction);
        resolve({
          address,
          family,
          status: valid ? "ok" : "invalid-response",
          responder: remote.address,
        });
      });
      socket.send(request, port, address);
    });
  } catch (error) {
    socket.close();
    return {
      address,
      family,
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

const results = [];
for (const host of hosts) {
  let addresses;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch (error) {
    results.push({
      host,
      status: "dns-error",
      detail: error instanceof Error ? error.message : String(error),
    });
    continue;
  }
  const probes = [];
  for (const entry of addresses) {
    probes.push(await probe(entry.address, entry.family));
  }
  results.push({ host, probes });
}

console.log(JSON.stringify(results, null, 2));
if (
  results.some(
    (result) =>
      "probes" in result &&
      result.probes.some((probeResult) => probeResult.status === "ok"),
  )
) {
  process.exit(0);
}
process.exit(1);
