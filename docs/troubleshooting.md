# Connection troubleshooting

[中文](./troubleshooting.zh-CN.md)

## Collect connection logs

Open the browser Console, enable Info and Warning messages, enable Preserve log, and filter for `[Peerto connection]` before reproducing on both devices. Entries include an anonymous browser-client label, attempt/connection counters, the assigned role, current ICE/SDP states, operation duration and safe error categories.

- `ws_connect/open/close`, `ws_timeout` and `ws_message_failed` locate signaling or authentication failures. A close after consumption can be expected.
- `sdp_create_offer/answer`, `sdp_set_local` and `sdp_set_remote` have `_start`, `_ok` and `_failed` entries. A failed entry includes the browser error category and SDP line number when available, never the SDP itself.
- `local_candidate`, `remote_candidate` and `ice_add_candidate_failed` distinguish gathering, queued/stale candidates and application failures. A single `ice_candidate_error` (including 701) does not by itself mean the entire connection failed; compare the other candidates and final ICE state.
- `ice_restart` and `previous_path_*` show fresh negotiation versus reuse of the retained path. A failed state still requires a manual retry.

Peerto keeps only the latest 200 entries per client in memory and writes them to the browser console; it does not upload them. Raw SDP, candidate addresses/ports, URLs, device names/keys, tokens, chat and file contents are excluded. Share only the filtered connection entries, not an unreviewed full browser log.

## QR links and clipboard attachments

Use the QR in “Connect another device” before its code expires. It is generated locally from the same-origin share link. A new browser must allow the consent cookie/local storage and choose its own name; the pending invitation survives these gates and is consumed only when the identity is ready. Returning browsers reuse their own identity and name. Opening the QR in a different browser or an in-app browser uses a different storage context: use the same browser to retain the same device. Cookies and private keys are never copied between devices.

Paste into the message input with the browser's normal paste action. Text stays editable; exposed files/screenshots appear in a confirmation dialog. Multiple files can also be selected with the attachment button. Remove unwanted items or cancel; only confirmation queues transmission. Up to 32 files can be queued per connection, sent serially. Switching conversations clears unconfirmed attachments; disconnecting cancels queued transfers, without automatic resending. Browsers/operating systems that expose only text or file paths instead of file bytes cannot provide those files through paste; use the file picker in that case.

## Direct connection keeps failing

Common causes:

- Both devices are behind symmetric NAT
- A carrier uses CGNAT
- A company or campus network restricts UDP
- Both devices share one egress NAT and the router lacks hairpin support
- A firewall drops the random UDP ports used by WebRTC
- Public STUN is unreachable from the current network

If you choose to use TURN, keep UDP and TCP URLs in Settings, then click Retry connection in the composer. Without TURN, check LAN reachability, UDP, firewalls, and STUN availability as described below.

STUN only discovers addresses. It does not relay data, so adding more STUN services cannot solve every NAT problem.

## Devices on the same LAN cannot connect

Browsers normally gather host candidates, but mDNS, guest Wi-Fi isolation, AP Client Isolation, and host firewalls can prevent local traffic.

Check:

1. Whether each device can reach the other over the LAN.
2. Whether Wi-Fi client isolation is enabled.
3. Whether a VPN changes the default route.
4. Whether the browser permits WebRTC.
5. Whether the firewall permits browser UDP traffic.

## A code exists but the other device cannot find the host

Hosts still require credentials and device-key verification, but differing HTTP and WSS egress IPs alone no longer cause rejection. If switching networks disconnects a conversation, click Retry connection in its composer. Expired ordinary pairing codes still need to be regenerated.

Check both system clocks, the HTTPS certificate, and WebSocket connectivity. The reverse proxy must handle the `/ws` Upgrade correctly.

## Recovery fails after a refresh

Recovery needs both browsers to retain:

- The same pairing code namespace
- The same high-entropy recovery token
- Their own P-256 private key
- The peer device identity

Both devices can click Retry connection in either order or simultaneously. If the previous authenticated transport is still retained, the click first probes it for up to 1.5 seconds; otherwise it starts fresh signaling and ICE. The server assigns roles after device proof, independent of HTTP request order. Opening a conversation or regaining network access does not reconnect automatically; failure waits for another click.

A cached IP alone cannot reopen a closed WebRTC connection: the old port, ICE credentials, and NAT mapping may no longer be valid. Previous-path reuse is limited to the existing authenticated socket retained for 30 idle seconds; it is not candidate rewriting or a shortcut around ICE security. Without TURN, some NAT/firewall combinations still cannot connect directly.

Recovery cannot succeed when the two sides no longer hold the same pairing namespace and recovery token, when either device private key changed, or when one side has a stale peer identity after only the other side was re-paired. If site data was cleared, private browsing was used, storage authorization was blocked, or the browser evicted storage, pair the devices again.

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
