# Connection troubleshooting

[中文](./troubleshooting.md)

## Direct connection keeps failing

Common causes:

- Both devices are behind symmetric NAT
- A carrier uses CGNAT
- A company or campus network restricts UDP
- Both devices share one egress NAT and the router lacks hairpin support
- A firewall drops the random UDP ports used by WebRTC
- Public STUN is unreachable from the current network

Keep both UDP and TCP TURN URLs in Settings, then reopen the conversation. If the header says "Relayed connection", direct connection failed and ICE selected TURN.

STUN only discovers addresses. It does not relay data, so adding more STUN services cannot solve every NAT problem.

## Devices on the same LAN cannot connect

Browsers normally gather host candidates, but mDNS, guest Wi-Fi isolation, AP Client Isolation, and host firewalls can prevent local traffic.

Check:

1. Whether each device can reach the other over the LAN.
2. Whether Wi-Fi client isolation is enabled.
3. Whether a VPN changes the default route.
4. Whether the browser permits WebRTC.
5. Whether the firewall permits browser UDP traffic.

A paired device can use a custom IP. The two devices still need a real route, and Peerto WebSocket signaling is still required for SDP exchange. A custom IP does not pin the random UDP port selected by the browser.

## A code exists but the other device cannot find the host

A connection code is bound to the source IP used when the host reaches Peerto. If the host moves from Wi-Fi to mobile data, toggles a VPN, or changes egress IP, the old room expires. Close the old dialog and create a new code.

Check both system clocks, the HTTPS certificate, and WebSocket connectivity. The reverse proxy must handle the `/ws` Upgrade correctly.

## Recovery fails after a refresh

Recovery needs both browsers to retain:

- The same pairing code namespace
- The same high-entropy recovery token
- Their own P-256 private key
- The peer device identity

When both devices open the conversation, the first registers and waits while the second joins. If site data was cleared, private browsing was used, or the browser evicted storage, pair the devices again.

## Mobile file receiving fails

Peerto streams received data into OPFS first, so Android does not need to create a destination file before transfer. Check:

- Free browser storage
- Site storage permission and quota
- Whether the operating system suspended the page
- Whether both pages stayed in the foreground
- Whether the file exceeds `MAX_FILE_BYTES`

If OPFS is unavailable, Peerto falls back to memory and a regular download. The operating system is more likely to terminate a large transfer in this mode.

The current protocol does not support resume. A refresh, network loss, or page close during transfer requires sending the file again.

## TURN is configured but no relay appears

ICE choosing a direct path is normal when direct connection works. To confirm TURN participation, inspect:

- `chrome://webrtc-internals` in Chrome
- `about:webrtc` in Firefox
- coturn container logs

If no relay candidate exists, check the TURN hostname, port, transport, username, password, firewall, and `external-ip`. When the TURN host is behind NAT, the complete relay port range needs a one-to-one mapping.

## Human verification fails

A Turnstile token expires quickly and can be used once. Refresh the page and try again. If failure continues, the site operator should check:

- Whether the Widget allows the current hostname
- Whether the server site key and secret belong to the same Widget
- Whether `TURNSTILE_ALLOWED_HOSTNAMES` contains the current hostname
- Whether CSP permits `https://challenges.cloudflare.com`
- Whether the server can reach Siteverify

Never paste the Turnstile secret into an Issue.

## Collecting diagnostic information

An Issue may include:

- Browser name and version
- Operating system
- Network types at both ends, such as home Wi-Fi, mobile data, or company network
- The connection stage and error code shown by the page
- Whether TURN is configured
- Whether another network reproduces the problem

Do not include:

- Connection codes or share links
- Recovery tokens
- TURN passwords
- Turnstile secrets
- Full SDP, ICE candidates, or real IP addresses
- Exported browser site storage
