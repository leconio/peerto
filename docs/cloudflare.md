# Cloudflare Tunnel, rate limits, and Turnstile

[中文](./cloudflare.zh-CN.md)

Cloudflare is the ingress for the Peerto web app and API only. Do not put TURN behind Tunnel or expose TURN endpoints and credentials in public Cloudflare responses.

## Tunnel

Bind the application to the local machine:

```dotenv
PEERTO_BIND_ADDRESS=127.0.0.1
PEERTO_PORT=3100
TRUST_PROXY=true
```

Example Tunnel ingress:

```yaml
ingress:
  - hostname: peerto.example.com
    service: http://127.0.0.1:3100
  - service: http_status:404
```

Peerto WebSocket traffic uses the same hostname and the `/ws` path. It does not need a separate Tunnel service. Do not expose port `3100` publicly.

## Application rate limits

The server enforces:

- Separate code creation counters for source IP and device identity
- Separate recovery counters for source IP and device identity
- Per-IP WebSocket connection and concurrency limits
- A signaling message budget for every WebSocket
- Size limits for request bodies, WebSocket frames, and protocol fields
- Browser Origin checks for REST and WebSocket

These limits run at the origin and do not depend on Cloudflare. Their thresholds are configurable in `.env.example`.

## Turnstile

Peerto does not challenge every visitor. After one IP address creates more than three connection codes in 10 minutes, the next creation requires Turnstile. Automatic recovery does not trigger a challenge because it already uses a device signature and a high-entropy recovery credential.

Create a Managed Turnstile Widget in the Cloudflare dashboard and add the production hostname to its allowlist. Then configure:

```dotenv
TURNSTILE_SITE_KEY=public_site_key
TURNSTILE_SECRET_KEY=server_only_secret_key
TURNSTILE_ALLOWED_HOSTNAMES=peerto.example.com
TURNSTILE_SOFT_LIMIT=3
TURNSTILE_WINDOW_SECONDS=600
```

To create a Widget through the API, the token needs account-level `Turnstile Sites Write` permission. Regular Zone WAF edit permission does not include it.

All three core variables must be present:

- `TURNSTILE_SITE_KEY`
- `TURNSTILE_SECRET_KEY`
- `TURNSTILE_ALLOWED_HOSTNAMES`

The application returns only the site key from `/api/config`. The secret never enters HTML, JavaScript, or logs. The server calls Siteverify and checks `success`, `action=create_room`, and the returned hostname. It does not create a room after verification failure.

A Turnstile token expires quickly and can be used once. Do not cache it in the browser or rely on frontend verification alone.

## WAF rules

In addition to origin rate limits, a Cloudflare rule can block common scanners. Replace the hostname in this example:

```text
(http.host eq "peerto.example.com" and
 http.request.uri.path in {
   "/.env"
   "/.git/config"
   "/wp-login.php"
   "/wp-admin"
   "/xmlrpc.php"
 })
```

Use the Block action.

Add a Rate Limiting Rule for expensive endpoints:

```text
(http.host eq "peerto.example.com" and
 (
   (http.request.method eq "POST" and
    http.request.uri.path in {"/api/rooms" "/api/rooms/reconnect"})
   or http.request.uri.path eq "/ws"
 ))
```

For a small public instance, a reasonable starting point is 15 requests per IP and data center in 10 seconds, followed by a 60-second block. Adjust it after observing real traffic. The edge threshold should allow a normal recovery burst. Application limits provide the finer device-level checks.

Do not apply Managed Challenge directly to `/api/*` or `/ws`. A Challenge Page returns HTML, so browser `fetch` does not receive the expected JSON and a WebSocket Upgrade fails. Peerto handles challenge-required actions with Turnstile inside the application.

Free plans have a small rule allowance. If all rules are in use, merge Peerto's host condition into an existing scanner or rate-limit rule with the same purpose. Do not overwrite rules for other sites.

## Bot Fight Mode

Do not enable Bot Fight Mode without testing. It may challenge API and WebSocket requests without a usable bypass, and a free plan may not allow path exceptions for Peerto. Peerto already has a strict protocol, origin limits, edge rate limits, and on-demand Turnstile. Observe those controls first.

## Caching

- `/api/health` may use a short cache, but monitoring should reach the origin or bypass that cache
- `/api/config` follows the application's 5-minute cache header
- `POST /api/rooms` and `POST /api/rooms/reconnect` are not cached
- `/ws` is not cached
- Content-hashed static assets may use a long cache
- HTML, the manifest, and the service worker must not use a long cache

## Checks

After deployment:

```bash
curl -i https://peerto.example.com/api/health
curl -i https://peerto.example.com/api/config
```

`/api/config` may contain public STUN URLs and a Turnstile site key. It must not contain TURN endpoints, TURN passwords, a Turnstile secret, or internal server statistics.

Current Cloudflare references:

- [Server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
- [Content Security Policy](https://developers.cloudflare.com/turnstile/reference/content-security-policy/)
- [Challenge types](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/)
