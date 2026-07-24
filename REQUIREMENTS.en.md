# Peerto requirements and implementation

[中文](./REQUIREMENTS.md)

> Status: MVP v1
>
> Date: 2026-07-23
>
> Deployment: one Docker container, no database, no Redis
> Connection scope: each conversation is one-to-one, with concurrent device connections in one browser

## 1. Product boundary

Peerto is a peer-to-peer transfer tool with a conversation interface similar to Telegram Web:

- The first conversation in the left column is always "Mine", followed by paired devices.
- The right side shows the current local conversation.
- The host generates a 6-digit connection code in one place.
- Code creation and entry stay at the bottom of the left column. The old connection status bar is not shown.
- Text and files travel only over WebRTC DataChannel.
- The server does not store, proxy, or inspect message and file content.
- Peerto is not a chat service. It has no accounts, online contact directory, groups, offline messages, or cloud history.
- Each device session owns its WebRTC connection, DataChannels, heartbeat, route, and file transfer state. The active connection limit is stored locally, defaults to 4, and can be set from 1 to 32. Switching conversations within the limit must not disconnect other online devices.

The browser stores:

- `localStorage`: device name, theme, known devices, recovery credentials, messages, and file metadata.
- IndexedDB: the P-256 device private key and file handles the browser allows to persist.
- OPFS: received files and local resource content when a persistent file handle is unavailable. Resources are never uploaded to the server. A user can remove one resource, clear all resources, or remove them with a conversation.

This version does not support old PWA builds. It contains no migration for old storage, REST/WSS fields, or file chunk protocols.

## 2. Minimal architecture

```text
Browser A ── REST + temporary WSS ── Peerto App
Browser B ── REST + temporary WSS ──┘

Browser A ═════ WebRTC DataChannel ═════ Browser B
```

One Peerto App process provides:

- Built PWA static files.
- REST APIs for room creation and recovery registration.
- Temporary WebSocket signaling for SDP and ICE.
- Bounded in-memory state with TTL.
- In-process rate limits for a single instance.

It does not use:

- Redis or another database.
- HTTP polling.
- Automatic connection to every device when the app starts.
- A permanent signaling WebSocket after DataChannel opens.
- A private TURN protocol owned by the application.

## 3. Connection and signaling lifecycle

### 3.1 First connection

1. The host creates a P-256 device key and a short-lived 6-digit code.
   - An unused and unexpired code remains active in the same browser session. Closing and reopening the dialog shows the same code instead of requesting another one.
2. The server writes the pending room, host source IP, and random host, share, and recovery credentials to TTL memory.
3. The host opens a temporary WSS connection and completes a challenge with its device private key.
4. The guest enters the 6-digit code or opens a share link.
5. The guest opens a temporary WSS connection and completes its device key challenge.
6. A regular code requires host approval. A valid share credential is approved automatically.
7. The server forwards the offer, answer, ICE candidates, and any required ICE restart messages.
8. Each side sends `connected` after its `control` DataChannel opens.
9. Only after both sides confirm, the server deletes the room, sends `room_consumed`, and closes both WSS connections normally.
10. Each browser treats that WSS closure as expected and keeps the P2P connection online.

A consumed short code cannot be joined again. The share credential expires with its room.

### 3.2 Recovery for known devices

- The connection code verifies identity only for the first pairing.
- After pairing, both browsers store the same high-entropy recovery token, their own private key, and the peer identity.
- Recovery starts only when the user opens a known device conversation. Closed conversations do not create network connections.
- Online devices remain connected when the user switches conversations, up to the active connection limit. At the limit, Peerto first removes the least recently used offline client, then disconnects the least recently used online client that is not open. A device that has never connected or is already offline recovers only when its conversation is opened.
- A recovery request sends the device identity, peer device ID, 6-digit namespace, and recovery token. It does not send or cache ICE addresses.
- The first device to register becomes the temporary host and waits. The second becomes the guest.
- Both devices repeat the private key challenge before exchanging WebRTC signaling.
- Loss of server memory, a container, or temporary registration does not remove the identity root. The two browsers can meet again while both still have their local credentials.
- If a private key or recovery token is cleared locally, the devices must pair again with a code or share link.

### 3.3 Retry after disconnect

- A briefly `disconnected` P2P connection waits 4 seconds.
- While temporary signaling still exists, Peerto attempts at most two ICE restarts. Each attempt has a 15-second connection window.
- After signaling has closed as expected, a real P2P disconnect starts recovery registration for the open conversation.
- Retries use exponential backoff capped at 30 seconds. The UI shows the attempt number, Retry now, and Cancel.
- If both devices open the same known conversation, each follows the same registration flow and they select host and guest automatically.
- While the retry overlay is visible, other actions in that conversation are disabled.

## 4. In-memory server state

The server stores only temporary state that can be discarded:

| State | Default limit | TTL or release condition |
|---|---:|---|
| Pending rooms | 2000 | 5 minutes by default, successful connection, or disconnect |
| Recovery credential namespaces | 5000 | Sliding 5 minutes |
| Device identities per credential | 64 | Released with the namespace |
| Rate-limit buckets | 50000 | Fixed window expiry |
| Active temporary WSS per IP | 12 | Connection close |

Implementation requirements:

- Use one shared cleanup timer rather than one timer per map record.
- Lazily remove expired values before every read.
- When a capacity limit is reached, remove expired values first. If the store is still full, fail closed instead of growing without a bound.
- The health endpoint returns service status only. It does not expose room counts or internal statistics.
- Support one application instance only. Multiple replicas would require shared coordination or session affinity, which is outside the current scope.

## 5. Identity, security, and IP addresses

Device identity:

```text
deviceId = SHA-256(stable P-256 public key)
```

Requirements:

- Both host and guest sign a random challenge from the server.
- After DataChannel opens, each side sends `peer_hello`. Its device ID and public key must match the signaling identity exactly.
- A 6-digit code is only a short-lived secret a user can type. It is not a long-term authentication credential.
- The high-entropy share credential is stored in the URL fragment. The page removes it from the address bar immediately after reading it.
- A recovery token is sent in the first message after the WebSocket opens, not in the WebSocket URL.
- WSS validates the `Origin` against the request Host.
- Logs contain no connection codes, tokens, SDP, ICE, messages, or files.
- The default CSP blocks third-party scripts and embedding. It permits only the optional Cloudflare Turnstile script and frame.
- REST write requests validate Origin and have separate limits for source IP and device identity.
- WSS has per-IP connection and concurrency limits, plus a signaling message limit for each connection.
- Code creation requires Turnstile after a soft threshold. The server validates the token, action, and hostname.
- REST and WSS accept the strict current protocol only. Old fields are rejected.

A temporary connection code is bound to the source IP seen by the signaling service:

- The source IP used to create a host code must match the IP used to open its WSS connection.
- After a guest is accepted, its temporary WSS is also bound to its source IP.
- An IP change invalidates the current temporary room.
- On the next visit, paired devices use recovery credentials to create a new room without another code.

The browser collects WebRTC ICE candidates for NAT traversal and route detection, but the home page does not show specific addresses:

- Collect `host`, `srflx`, `prflx`, and related addresses.
- Valid public, LAN, CGNAT, ULA, link-local IPv4/IPv6, and mDNS candidates continue to participate in ICE.
- Determine the active route from the selected candidate pair.
- Do not ask the Peerto server for "my IP" or write these addresses into recovery registration.
- The home page shows only a light state such as detecting, available, restricted, cached, unavailable, or offline. The refresh action sits next to this text.
- After connection, read the selected candidate pair from `RTCIceTransport` first and use WebRTC Stats for compatibility with mobile browsers.
- The two devices exchange only a route type and UDP/TCP summary over the authenticated DataChannel. They do not exchange candidate IP addresses. Symmetric normalization keeps the connection label the same on both sides.

## 6. WebRTC, STUN, and TURN

Default public STUN servers:

```text
stun:stun.chat.bilibili.com:3478
stun:stun.miwifi.com:3478
stun:stun.hitv.com:3478
stun:stun.cloudflare.com:3478
stun:stun.l.google.com:19302
```

- STUN discovers `srflx` candidates. It does not relay application traffic.
- Browser ICE checks LAN `host`, IPv4, and IPv6 candidates in parallel.
- The Settings page can replace the STUN list.
- TURN accepts multiple standard URLs. They share one username and credential and are combined into one standard `RTCIceServer`. Any coturn or compatible service can replace the current TURN service.
- STUN and TURN do not conflict. ICE normally prefers a lower-cost direct candidate pair and uses relay when direct connection fails.
- For a relayed connection, the host initiates ICE restarts over the existing control DataChannel. Attempts follow a 15-second, 1-minute, 5-minute, 15-minute, and 30-minute backoff, then repeat every 30 minutes. Automatic attempts wait while a file is transferring.
- Settings includes "Relay only". When enabled, Peerto uses the standard `iceTransportPolicy: "relay"`, gathers no direct candidates, and disables relay-to-direct upgrade attempts.
- Without TURN, some symmetric NAT, carrier network, firewall, and same-egress NAT combinations may fail. That is an accepted result.
- A regular browser application cannot reproduce NATMAP port mapping. The standard browser options remain ICE, STUN, and TURN.
- Each paired device can store one custom IPv4 address or routable IPv6 address. A `fe80::/10` link-local IPv6 address without a browser-usable zone ID is rejected. In custom IP mode, that device session uses empty `iceServers`, does not contact STUN or TURN, accepts host candidates only, and rewrites the remote host candidate to the configured address in the browser.
- A custom IP does not bypass WebRTC signaling or pin the browser's randomly assigned UDP port. It requires a real route between the devices and a firewall that permits WebRTC UDP. It cannot traverse unrelated NATs by itself.

## 7. State model

| State | Condition |
|---|---|
| Offline | No open `control` DataChannel |
| No network | The browser reports no network |
| Signaling | Creating or connecting a temporary WSS |
| Waiting for peer | Recovery room registered, waiting for the other device to open the conversation |
| Verifying identity | Running the device private key challenge |
| Connecting | Exchanging SDP and ICE |
| Online | `control` DataChannel open and P2P heartbeat healthy |
| Reconnecting | The open conversation is running short recovery or backoff registration |
| Direct connection failed | Automatic ICE attempts are exhausted; suggest TURN, or check the address, route, and firewall in custom IP mode |

P2P sends a heartbeat every 10 seconds and considers the connection unhealthy after 30 seconds without a `pong`. The server does not maintain long-term presence.

## 8. Messages and files

The `control` DataChannel carries:

- `peer_hello`
- Text, reply references, and pin updates
- Message acknowledgements
- Single-message deletion requests and results
- Conversation deletion requests and results
- File offer, accept, reject, end, and complete messages
- File receiver window acknowledgements
- Heartbeats

The `file` DataChannel:

- Carries binary file chunks only.
- Gives every frame a fixed magic value, `transferId`, monotonic sequence, and payload.
- Uses a 16 KiB payload by default and never exceeds the browser's negotiated SCTP message size.
- Has the receiver validate the transfer ID, sequence, and total size.
- Has the receiver acknowledge after writing about 128 KiB or after the final write.
- Allows the sender to run about 512 KiB ahead at most, which bounds mobile memory and DataChannel buffering.
- Starts a local download automatically after an offer. The receiver does not approve each file manually.
- Marks the sender as delivered only after the receiver writes the file to OPFS or creates a fallback download and sends `file_complete`.
- Allows one outgoing and one incoming transfer at a time. It does not support resume or background transfer.

The receiver streams files into the local OPFS resource cache. This avoids Android `createWritable()` failures and removes the need to choose a save location first. Images and video retain their original bytes, with no compression or transcoding, and appear in the conversation through a local Object URL after completion. Documents appear as file cards. The Resources page shows local content in a grid and supports preview, download, single deletion, and clearing all resources. Deleting a resource removes local content but keeps the message and file metadata. Only when OPFS is unavailable does Peerto assemble a Blob in memory and trigger a browser download. There is no separate 100 MiB limit, but the default global 2 GiB limit still applies.

Deleting a complete conversation uses a remote-first, two-stage order:

- "Also delete data on the other device" is available only while that device's `control` DataChannel is online.
- Without the option, Peerto deletes local messages, resources, and pairing records only.
- With the option, the local device sends a conversation deletion request with a unique ID. The dialog cannot close or submit again while it waits.
- The peer stops transfers for that conversation, strictly removes messages, OPFS resources, file handles, and pairing records, then returns success or failure.
- The local device stops transfers and deletes its data only after the peer reports success. If remote cleanup fails, the connection closes, or no confirmation arrives within 60 seconds, local data stays unchanged and the UI reports failure.
- After success, neither side keeps conversation history. A side that has deleted the conversation ignores later business messages on that connection so concurrent messages cannot recreate history during deletion.

## 9. PWA, mobile, and internationalization

- The PWA manifest uses `standalone`.
- Mobile browsers use `viewport-fit=cover` and the dynamic keyboard viewport. Installed iOS mode uses a transparent status bar and accounts for top, bottom, and landscape safe areas.
- The service worker precaches the application shell and hashed static files, then removes old caches.
- HTML, the service worker, the manifest, and the registration script must not be cached for a long time. Hashed assets use an immutable one-year cache.
- Offline users can open the app and use "Mine", but cannot create a code or establish P2P.
- Mobile uses a single-column conversation view, touch-sized controls, and safe-area spacing.
- The home page does not show ICE addresses. A light connection-environment state appears under Peerto, with manual candidate collection next to the text.
- The default device name comes from a stable short device identity. A custom name takes precedence and is not overwritten automatically.
- Language, theme, and ICE settings are stored locally.
- Settings uses a two-column category layout with General, Appearance, Connection, and Resources. Connection includes the active device limit, multiple STUN URLs, multiple TURN URLs, one shared TURN username and password, and Relay only.

## 10. Deployment and acceptance

Compose contains one `app` service. It does not include Caddy, Redis, or coturn. An existing ingress provides public TLS, and TURN remains independent of the application deployment.

Required checks:

- TypeScript type checking for every workspace.
- Unit tests for the server, web app, and shared protocol.
- Production build.
- Compose configuration validation.
- Health check.
- First connection with a regular code, share link, bidirectional signaling, and WSS closure after both sides are online.
- Automatic recovery by both sides after server state is cleared.
- Rejection of old protocol fields.
- File v2 frame encoding, sequence, window acknowledgement, and completion acknowledgement.

General production target:

- The operator chooses the installation path and public hostname. Neither belongs in the repository.
- Behind a reverse proxy, the published host port binds only to loopback or a protected internal network.
- The public ingress provides HTTPS and WebSocket Upgrade.
- Use `TRUST_PROXY=true` only with a controlled reverse proxy. Rate limits and temporary room binding use the client source IP forwarded by that proxy.
- coturn runs independently and is not started or modified by the Peerto Compose file.

## 11. Project organization

- npm workspaces separate `apps/web`, `apps/server`, and `packages/protocol`.
- Frontend features separate conversations, connection, messages, resources, retry, session adapters, settings, and file transfer. The page entry only composes state and views.
- The WebRTC/WSS state machine belongs in `services/peer`. React components do not maintain the low-level `PeerConnection`.
- Chinese and English strings live in `locales/zh.ts` and `locales/en.ts`, not in page components.
- Server composition, configuration, plugins, REST routes, static files, device security, WebSocket signaling, and the TTL memory store are separate modules.
- Shared schemas, messages, and file frame types can be defined only in `packages/protocol`.
- Unit tests stay next to their implementation. Server application tests cover protocol, security, and lifecycle behavior as a black box.
- See [ARCHITECTURE.en.md](./ARCHITECTURE.en.md) for detailed directory boundaries.
