# Privacy

[中文](./privacy.md)

This page describes how a self-hosted Peerto deployment handles data in the browser, the Peerto application, and network helper services.

## Browser-local data

The current browser stores:

- Device name and stable device ID
- P-256 device private key
- Public keys and recovery credentials for paired devices
- Local messages, filenames, and transfer state
- User-selected STUN, TURN, and custom IP settings
- File handles and resource content in OPFS

This data does not synchronize to another browser automatically. Clearing site data removes the identity, pairings, and local history, so the devices must pair again.

TURN usernames and passwords are stored only in the current browser. A person or extension that can read that browser's site data may obtain them. Do not store private TURN credentials on a public device.

## Peerto application server

During connection setup, the application server handles:

- Source IP addresses
- 6-digit connection codes
- Device names, IDs, and public keys
- Hashes of short-lived random credentials
- SDP and ICE candidates
- WebSocket state

This information is used for authentication, rate limits, and WebRTC setup. Rooms have a short TTL and are released as soon as both devices are online over P2P. Restarting the application process also clears all rendezvous state.

The application server does not receive or store:

- Message bodies
- File contents
- P-256 private keys
- Browser-local history
- TURN settings entered by a user

Logging hides request URLs and does not record codes, tokens, SDP, ICE, messages, or files. Operators should still restrict log access and check whether the ingress records complete query parameters.

## STUN

The browser sends Binding requests to configured STUN services to discover public mapped addresses. A STUN service sees the source IP of each request. The default list contains third-party public services, and the Peerto operator cannot promise their retention or privacy policy.

Replace the default list in Settings if you do not want to contact public STUN services.

## TURN

Application traffic passes through TURN only when ICE needs a relay. A TURN operator can see both endpoint IP addresses, connection time, and traffic volume. DTLS encryption on WebRTC DataChannel still protects message and file content.

The Peerto application server does not supply TURN endpoints or credentials. A user configures them in the current browser.

## Cloudflare

When a deployment uses Cloudflare Tunnel, proxying, WAF, or Turnstile, Cloudflare handles requests to the Peerto web app and API. It can see source IP addresses, request paths, and browser information. Processing depends on the site operator's Cloudflare settings and policies.

A Turnstile token is used only to verify code creation. The Peerto server does not keep the token after verification.

## Deletion

The Resources page can remove one local file or clear all local files. Deleting a conversation removes messages, resources, and pairing records from the current browser. If the peer is online, the user may ask it to delete the same conversation first. Local deletion begins only after the peer confirms success.

Temporary server state cannot restore chat history. It expires automatically and has no export endpoint.
