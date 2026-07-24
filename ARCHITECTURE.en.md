# Peerto architecture

[中文](./ARCHITECTURE.md)

Peerto uses npm workspaces for the web app, server, and shared protocol package. Directories follow runtime boundaries and business responsibilities. Entry files compose modules but do not hold business logic.

## Workspace

```text
peerto/
├── apps/
│   ├── web/                 React PWA
│   └── server/              Fastify static files, REST, and temporary WSS
├── packages/
│   └── protocol/            Shared protocols, schemas, and file frame format
├── scripts/                 Acceptance and network diagnostic scripts
├── Dockerfile
└── compose.yaml
```

## Web

```text
apps/web/src/
├── App.tsx                  Page composition and top-level state wiring
├── main.tsx                 React, PWA, and i18n startup
├── components/              Shared UI without a business owner
├── features/
│   ├── chat/                Conversation panel
│   ├── connection/          Codes, share links, and connection actions
│   ├── conversations/       Conversation list
│   ├── messages/            Message flow, replies, pins, and actions
│   ├── resources/           Local preview, download, and deletion
│   ├── retry/               Session recovery and backoff
│   ├── security/            On-demand Turnstile verification
│   ├── session/             Peer pool, scoped events, and UI adapters
│   ├── settings/            Settings UI
│   └── transfers/           File selection, progress, and transfer UI
├── hooks/                   Business-independent React hooks
├── lib/                     Pure functions, browser APIs, local persistence
├── locales/                 Chinese and English resources
├── services/
│   └── peer/                WebSocket/WebRTC state machine and public types
├── store.ts                 Persistent local state
└── styles/                  Shared visual contract
```

Dependency direction:

```text
main → App → features/components
                 ↓
          services/lib/store
                 ↓
              protocol
```

- `App.tsx` wires state, feature hooks, and page sections. It should not define large UI blocks.
- Features may depend on shared components, services, `lib`, and the store. They must not depend back on `App.tsx`.
- WebRTC, WSS, ICE, and file transfer protocols belong in `services/peer`. React components do not manipulate low-level connections.
- Every connected device has its own `PeerClient`. The pairing client is separate from device session clients, so switching conversations does not reuse one connection.
- The default device session limit is 4 and can be set from 1 to 32. At the limit, Peerto first removes the least recently used offline client. It then disconnects the least recently used online client that is not the open conversation. Opening a removed session creates it again when needed.
- A custom IP stays in the local `KnownPeer` record. `PeerClient` disables ICE servers for that device and rewrites the remote host candidate in the browser.
- ICE settings combine multiple TURN URLs into one standard `RTCIceServer` with one username and password. TURN remains independent of the application deployment.
- Deleting a conversation on both devices uses request and result messages over the authenticated `control` DataChannel. `features/conversations` waits for remote success before local deletion. The store removes messages, resources, and pairing state strictly, and never reports success after a cleanup failure.
- User-facing copy belongs in `locales`. Business modules use translation keys.
- `styles/ui.module.css` is the current visual contract. Global themes and browser defaults live in `styles.css`.

## Server

```text
apps/server/src/
├── index.ts                 Process startup, listen, and shutdown
├── app.ts                   Fastify composition root
├── config/                  Environment parsing and runtime config
├── plugins/                 Security headers and WebSocket plugins
├── routes/                  REST API and static PWA files
├── security/                Device signatures, identity, and Turnstile
├── signaling/               Temporary WSS room state and forwarding
└── storage/                 Bounded in-memory room store with TTL
```

Dependency direction:

```text
index → app → plugins/routes/signaling
                         ↓
                security/storage/config
                         ↓
                      protocol
```

- `app.ts` creates dependencies and registers plugins, routes, and signaling.
- REST routes do not hold WebSocket runtime state.
- The signaling module does not serve static files or regular HTTP routes.
- `RoomStore` owns all short-lived state. Business modules must not create unbounded global maps.
- REST write requests have separate rate limits for IP addresses and device identities. They also validate the browser Origin.
- WebSocket connections have per-IP connection, concurrency, and per-connection message limits.
- Turnstile protects code creation only after the soft threshold. Its secret stays on the server.
- The server never handles message bodies or file contents.

## Tests and change rules

- Keep pure function and state machine tests next to their implementation.
- `apps/server/src/app.test.ts` covers the server protocol and security boundary as a black box.
- `scripts/acceptance.mjs` checks the built application in a public or container runtime.
- Put new business logic in its feature or service module. Only cross-domain wiring belongs in `App.tsx` or `app.ts`.
- Add shared client-server fields to `packages/protocol` first. Do not copy types into both applications.
