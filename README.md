# Peerto

[中文](./README.zh-CN.md)

[Live demo](https://peerto.aside0.me)

Peerto sends messages and files directly between browsers with WebRTC DataChannel. It looks like a chat app, but it is not a hosted chat service. The application server serves the web app, issues short-lived connection codes, and relays signaling only while two devices connect.

## Features

- Pair two devices with a short-lived 6-digit code
- Connect from a share link without another approval step
- Restore a verified device connection when its conversation is opened
- Keep several peer connections active in one browser, with a default limit of 4
- Send text, original images, video, and other files
- Reply to, pin, and delete messages you sent
- Stream files in chunks into browser-local storage
- Preview, download, and remove local resources
- Configure multiple STUN URLs, multiple TURN URLs, relay-only mode, or a custom peer IP
- Install as a PWA on desktop or mobile
- Use the interface in English or Chinese

Each conversation is still one-to-one. Peerto has no accounts, groups, cloud history, offline delivery, or server-side presence directory.

## Where data is stored

Messages and pairing records stay in the current browser. IndexedDB stores the device key and file handles. Received file data is written to OPFS. The application server does not store message bodies or file contents.

During connection setup, the server handles a code, device public keys, source IP addresses, SDP, and ICE candidates. This state is bounded and expires quickly. It is deleted once the peer connection is ready. See [Privacy](./docs/privacy.md) for the full boundary.

## Run with Docker

Docker and Docker Compose are required:

```bash
cp .env.example .env
docker compose up -d --build
```

Open `http://localhost:3000`. A public deployment needs HTTPS and WSS. Use any reverse proxy or Cloudflare Tunnel you already operate. Caddy is not required.

The default build contains public STUN URLs only. It contains no TURN endpoint or credential. Users can add a TURN server in Settings, or operators can follow the [coturn guide](./docs/turn.md). When a connection uses TURN, Peerto periodically renegotiates it and tries to upgrade to a direct path. Enable Relay only to keep a connection on TURN.

## Development

Node.js 22 or newer is required:

```bash
npm install
npm run dev
```

Run the full local check before submitting a change:

```bash
npm run check
```

The repository uses npm workspaces:

```text
apps/web/          React PWA
apps/server/       Fastify static files, API, and temporary signaling
packages/protocol/ Shared schemas and protocol types
deploy/            Deployment examples
docs/              Operations and security notes
```

## Documentation

- [Docker and production deployment](./docs/deployment.md)
- [Deploying and using coturn](./docs/turn.md)
- [Cloudflare Tunnel, rate limits, and Turnstile](./docs/cloudflare.md)
- [Connection troubleshooting](./docs/troubleshooting.md)
- [Project structure](./ARCHITECTURE.md)
- [Requirements and protocol boundaries](./REQUIREMENTS.md)

## Contributing

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening a pull request. Report vulnerabilities using [SECURITY.md](./SECURITY.md), not a public issue.

## License

[MIT](./LICENSE)
