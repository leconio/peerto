# Contributing to Peerto

[中文](./CONTRIBUTING.md)

Thank you for spending time on Peerto. Before changing code, check that the proposal still fits the project boundary: messages and files do not pass through the application server, and the project has no accounts, database, or permanent presence directory.

## Reporting a problem

Use an Issue for an ordinary bug. Include the browser, operating system, network type at both ends, reproduction steps, and the error code shown by the page.

Do not paste connection codes, share links, recovery tokens, TURN passwords, Turnstile secrets, real IP addresses, full SDP, or ICE candidates. Report security issues privately as described in [SECURITY.en.md](./SECURITY.en.md).

## Development environment

Node.js 22 or newer is required:

```bash
npm install
npm run dev
```

The frontend runs on port 5173 by default and proxies API and WebSocket traffic to port 3000.

## Submitting changes

1. Add tests for bug fixes and protocol changes.
2. Change `packages/protocol` first when a field is shared by the client and server.
3. Update Chinese and English user-facing copy together.
4. Do not commit `.env`, TURN configuration, certificates, private keys, or packet captures.
5. Do not keep old protocol compatibility branches unless the maintainers explicitly change the current policy.
6. Update related documentation in both the Chinese `.md` and English `.en.md` files.

Run these commands before submitting:

```bash
npm run check
docker compose config --quiet
```

WebRTC changes should be tested in at least two independent browsers. Cover the first connection, recovery, and disconnect behavior. File transfer changes should cover an empty file, a small file, cancellation of a large file, and mobile receiving.

## Pull requests

A pull request should explain:

- What changed
- Why it changed
- How it was verified
- Whether it changes local storage, the shared protocol, the privacy boundary, or deployment configuration

Keep each pull request focused on one topic. For a large refactor, open an Issue first and describe the directory and protocol impact.
