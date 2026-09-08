# Changelog

[中文](./CHANGELOG.zh-CN.md)

Peerto is still at an early stage. Once releases begin, user-visible changes will be recorded by date, starting with the latest version.

## Unreleased

### Added

- Locally generated pairing QR codes with consent/name onboarding and invitation handoff; concurrent first-use tabs retain one device key
- Composer paste for text, screenshots and multiple files, with attachment confirmation/removal and a bounded serial transfer queue
- Redacted console connection traces for WSS, SDP operations, ICE candidates/states and restarts, with per-attempt context and a 200-entry in-memory buffer
- Open source license, contribution guide, security policy, and deployment documentation
- Independent coturn Compose file and secure configuration example
- On-demand Turnstile verification for connection code creation
- Layered rate limits for REST, devices, and WebSocket connections
- CI, dependency update, and secret scanning configuration
- Required storage-consent gate and first-use device naming
- Direct peer IP display for an active non-relayed connection

### Changed

- Removed automatic standalone STUN probes, combined new-client recovery registration into WSS, and added mutually confirmed early signaling release with the 30-second fallback intact
- Added a global socket cap and replaced 15-second Node health probes with 30-second lightweight probes without routine health access logs
- Offline composers now offer manual retry, without automatic reconnect on navigation, disconnect, or network return, and without a modal overlay
- Retry can reuse a briefly retained authenticated path before fresh ICE; recovery roles are assigned after device proof with per-negotiation stale-frame isolation, independent of arrival order
- Review hardening: authenticate before host replacement, bound pending guest authentication, protect accepted peers and stale approvals, coalesce/cancel address probes, and remove retired reconnect/room-overwrite branches
- Isolated ICE candidate generations, bounded recovery duration, and finalized file state on disconnect
- Joinable rooms expire immediately after connection, with a 30-second authenticated signaling stabilization window; verified identities can connect across egress IP changes

- Known-peer recovery now starts a fresh authenticated rendezvous after an offline period
- Removed custom peer IP routing and its saved legacy values
- Shortened the sidebar connection actions and added a GitHub repository shortcut

### Security

- Updated Fastify and vulnerable transitive runtime/build dependencies; npm audit reports no vulnerabilities at release validation
- The public health endpoint no longer returns room counts
- Default configuration, public APIs, and frontend builds contain no TURN endpoint or credential
- Code creation and recovery endpoints now validate same-origin requests
