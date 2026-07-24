# Deploying and using TURN

[中文](./turn.md)

Peerto uses the standard `RTCIceServer` configuration and does not depend on one TURN provider. coturn, cloud TURN services, and other compatible servers are interchangeable.

The default build includes public STUN only. The repository, Docker image, `/api/config`, and frontend scripts contain no private TURN endpoint, port, username, or password from the project maintainer.

## Can a TURN endpoint be hidden?

It cannot be hidden from a browser that uses it. The browser needs the TURN endpoint and credentials to create a relay candidate, and a network observer can see the destination.

In this project, keeping TURN private means:

- Do not write a private TURN endpoint into the repository, examples, image, or public API
- Do not put credentials in frontend build variables
- Enter them only in browser Settings where needed
- Rotate credentials and use quotas and bandwidth limits to control abuse

An unusual hostname or port may reduce random scanning, but it cannot replace authentication, rate limits, and a firewall.

## Starting coturn with Docker

The repository provides an independent Compose file:

```bash
cd deploy/coturn
cp turnserver.conf.example turnserver.conf
```

Create a random password:

```bash
openssl rand -base64 36
```

Edit the local `turnserver.conf`:

1. Set `external-ip` to the server's public address.
2. Set `realm` to the TURN hostname.
3. Replace `CHANGE_ME_WITH_A_LONG_RANDOM_PASSWORD`.
4. Remove `listening-ip=::` if the server has no IPv6.
5. If the server is behind NAT, follow coturn documentation and write `external-ip` as `public-IP/private-IP`.

`turnserver.conf` is excluded by `.gitignore`. Do not paste the real configuration into an Issue or log attachment.

Start coturn:

```bash
docker compose up -d
docker compose logs --tail=100 coturn
```

The example pins an image version instead of following `latest`. Read the coturn release notes before changing the tag.

## Firewall

The example configuration requires:

- UDP 3478
- TCP 3478
- UDP 49160 through 49200
- TCP 5349 when using TURN over TLS

The listening ports may change, but the relay UDP range from `min-port` through `max-port` must be open too. Cloudflare Tunnel and ordinary HTTP reverse proxies cannot carry general TURN UDP traffic. TURN should use public UDP directly or a layer 4 proxy that supports the protocol.

If the coturn host is behind NAT, the router must preserve a one-to-one mapping for relay ports. Mapping port 3478 alone is not enough.

## Browser configuration

Peerto Settings accepts multiple STUN and TURN URLs, one per line. All TURN URLs share one username and password.

Common forms:

```text
turn:turn.example.com:3478?transport=udp
turn:turn.example.com:3478?transport=tcp
turns:turn.example.com:5349?transport=tcp
```

Notes:

- `turn:` can use UDP or TCP
- `turns:` means TURN over TLS
- UDP usually has lower latency
- TCP/TLS works on some networks that block UDP strictly

STUN and TURN do not compete. ICE checks all candidate pairs, usually preferring a host or server-reflexive direct path and selecting relay only when direct connection fails. The connection type at the top of the conversation shows the selected path.

When a connection uses relay, the host starts ICE restarts on a backoff schedule and tries to move to a direct path. Renegotiation travels over the existing encrypted DataChannel, so the application server does not keep signaling state. Automatic attempts wait until an active file transfer finishes.

"Relay only" in Settings uses the browser's standard `iceTransportPolicy: "relay"`. It gathers TURN relay candidates only and disables direct upgrade attempts. Use it to test TURN or on a network that must not expose local direct candidates. It increases TURN bandwidth use and latency.

## TLS

For `turns:`, add these paths to the coturn configuration:

```text
cert=/etc/coturn/certs/fullchain.pem
pkey=/etc/coturn/certs/privkey.pem
```

The certificate directory is excluded by `.gitignore`. Mount it read-only and make sure the container user can read the files. The certificate hostname must match the `turns:` URL.

## Abuse controls

The example configuration:

- Uses long-term credentials
- Limits total and per-user allocations
- Limits bandwidth for each allocation
- Disables the administrative CLI
- Prevents relay access to private, loopback, and multicast addresses
- Uses a small relay port range that is practical to allow through a firewall

A public TURN service should not share one static account indefinitely. As traffic grows, use coturn TURN REST authentication to issue short-lived HMAC credentials. The credential service can run independently. Peerto still consumes standard URLs, a username, and a credential, with no signaling protocol change.

Rotate a leaked static credential immediately:

1. Create a new password and update coturn.
2. Restart coturn.
3. Update Settings in browsers that need it.
4. Check allocation counts, outbound bandwidth, and unusual sources.

## Verification

First check that coturn listens and creates relay allocations:

```bash
docker compose ps
docker compose logs --tail=100 coturn
```

Then connect two devices that are not on the same LAN. "Relayed connection" in the conversation means ICE selected TURN. `chrome://webrtc-internals` in Chrome or `about:webrtc` in Firefox can also confirm that the selected candidate pair contains `relay`.

An always-direct result is normal. To verify TURN, temporarily enable "Relay only" and disable it after the test.

See the [official coturn configuration](https://github.com/coturn/coturn/blob/master/docker/coturn/turnserver.conf) for all options and security notes.
