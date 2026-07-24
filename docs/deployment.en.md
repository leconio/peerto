# Production deployment

[中文](./deployment.md)

Peerto uses one application container. It serves the static page, two REST endpoints, and temporary WebSocket signaling. It needs no Redis or database.

## Requirements

- Docker Engine 24 or newer
- Docker Compose v2
- A public ingress with HTTPS and WebSocket support
- A single application instance

WebRTC, service workers, and browser file-system APIs require a secure context on a public site, so production must use HTTPS.

## Start

```bash
git clone <repository-url>
cd peerto
cp .env.example .env
docker compose up -d --build
```

The default bind is `0.0.0.0:3000`. If the TLS ingress runs on the same machine, bind Peerto to loopback:

```dotenv
PEERTO_BIND_ADDRESS=127.0.0.1
PEERTO_PORT=3100
TRUST_PROXY=true
```

Check application health:

```bash
curl --fail http://127.0.0.1:3100/api/health
```

A healthy application returns only:

```json
{"status":"ok"}
```

## Environment variables

| Variable | Default | Description |
|---|---:|---|
| `PEERTO_BIND_ADDRESS` | `0.0.0.0` | Host address used by the Compose port binding |
| `PEERTO_PORT` | `3000` | Host port published by Compose; the container listens on 3000 |
| `ROOM_TTL_SECONDS` | `300` | TTL for connection rooms and recovery registration |
| `MAX_PENDING_ROOMS` | `2000` | Maximum pending rooms in memory |
| `MAX_CODE_RECORDS` | `5000` | Maximum recovery credential namespaces |
| `MAX_CODE_MEMBERS` | `64` | Devices registered under one recovery credential |
| `MAX_RATE_BUCKETS` | `50000` | Maximum in-memory rate-limit buckets |
| `RATE_LIMIT_CREATE_PER_MINUTE` | `12` | Code creations per IP per minute |
| `RATE_LIMIT_CREATE_PER_DEVICE_PER_MINUTE` | `6` | Code creations per device per minute |
| `RATE_LIMIT_RECONNECT_PER_MINUTE` | `60` | Recovery requests per IP per minute |
| `RATE_LIMIT_RECONNECT_PER_DEVICE_PER_MINUTE` | `30` | Recovery requests per device per minute |
| `RATE_LIMIT_WS_PER_MINUTE` | `60` | WebSocket connections per IP per minute |
| `MAX_WS_CONNECTIONS_PER_IP` | `12` | Concurrent temporary WebSockets per IP |
| `MAX_WS_MESSAGES_PER_MINUTE` | `240` | Signaling messages per WebSocket per minute |
| `STUN_URLS` | See `.env.example` | Comma-separated public STUN list |
| `MAX_FILE_BYTES` | `2147483648` | Maximum file size allowed by the frontend |
| `TRUST_PROXY` | `false` | Trust the client IP forwarded by the ingress |

Use `TRUST_PROXY=true` only behind a controlled proxy. Do not expose the application port directly at the same time. A direct client could forge forwarded headers and interfere with rate limits and temporary IP binding.

The official Compose file exposes only `PEERTO_PORT` to users. The Node process inside the container uses the standard `PORT=3000`, which Compose fixes internally and does not belong in `.env`.

See [Cloudflare protection](./cloudflare.en.md) for Turnstile variables. Turnstile is completely disabled when all three core variables are empty.

## Ingress proxy

The ingress must forward:

- `/` and static assets
- `/api/config`
- `/api/health`
- `POST /api/rooms`
- `POST /api/rooms/reconnect`
- WebSocket Upgrade on `/ws`

Do not cache REST write requests or WebSocket traffic. `/api/config` can follow the application's cache headers, and hashed frontend assets can use a long cache.

See [Cloudflare protection](./cloudflare.en.md) for a Tunnel example. With Nginx, make sure `/ws` forwards the `Upgrade` and `Connection` headers.

## Update and rollback

The application has no database migration. Keep the previous image before an update:

```bash
docker image tag peerto:local peerto:rollback
git pull --ff-only
docker compose build
docker compose up -d
```

If checks fail, temporarily change the Compose image to `peerto:rollback` and start it again. Browser protocols do not promise compatibility with old versions, so avoid serving old and new application instances at the same time.

## Preflight checks

```bash
npm ci
npm run check
docker compose config --quiet
docker compose up -d --build
curl --fail http://127.0.0.1:3000/api/health
BASE_URL=http://127.0.0.1:3000 npm run acceptance
```

Also confirm:

- The application port is not publicly reachable
- The HTTPS certificate is valid and WebSocket Upgrade works
- Logs contain no code, credential, SDP, or ICE content
- `.env`, TURN configuration, certificates, and private keys are not committed
- Cloudflare or the ingress has an independent request rate limit
- Only one Peerto application instance handles rendezvous state
