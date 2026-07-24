# Changelog

[中文](./CHANGELOG.md)

Peerto is still at an early stage. Once releases begin, user-visible changes will be recorded by date, starting with the latest version.

## Unreleased

### Added

- Open source license, contribution guide, security policy, and deployment documentation
- Independent coturn Compose file and secure configuration example
- On-demand Turnstile verification for connection code creation
- Layered rate limits for REST, devices, and WebSocket connections
- CI, dependency update, and secret scanning configuration

### Security

- The public health endpoint no longer returns room counts
- Default configuration, public APIs, and frontend builds contain no TURN endpoint or credential
- Code creation and recovery endpoints now validate same-origin requests
