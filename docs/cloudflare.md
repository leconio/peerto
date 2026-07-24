# Cloudflare Tunnel、限流与 Turnstile

[English](./cloudflare.en.md)

Cloudflare 只作为 Peerto Web 和 API 的入口。TURN 不应放进 Tunnel，也不要把 TURN 地址或凭据写进 Cloudflare 的公开响应。

## Tunnel

让应用只监听本机：

```dotenv
PEERTO_BIND_ADDRESS=127.0.0.1
PEERTO_PORT=3100
TRUST_PROXY=true
```

Tunnel ingress 示例：

```yaml
ingress:
  - hostname: peerto.example.com
    service: http://127.0.0.1:3100
  - service: http_status:404
```

Peerto 的 WebSocket 使用同一个域名和 `/ws` 路径，不需要单独的 Tunnel 服务。不要再把 `3100` 端口开放到公网。

## 应用内限流

服务端自带以下限制：

- 创建码按来源 IP 和设备身份分别计数
- 恢复请求按来源 IP 和设备身份分别计数
- WebSocket 按 IP 限制建连频率和并发数
- 每条 WebSocket 有单独的信令消息预算
- 请求体、WebSocket 帧和协议字段都有大小上限
- REST 与 WebSocket 会检查浏览器 Origin

这些限制在源站执行，不依赖 Cloudflare。相关阈值在 `.env.example` 中可调。

## Turnstile

Peerto 不会要求每个访客先过验证码。一个 IP 在 10 分钟内创建连接码超过 3 次后，下一次创建才触发 Turnstile。自动恢复连接不触发验证码，因为它已经使用设备签名和高熵恢复凭据。

在 Cloudflare 控制台创建 Managed Turnstile Widget，把生产域名加入允许列表。然后配置：

```dotenv
TURNSTILE_SITE_KEY=公开的_site_key
TURNSTILE_SECRET_KEY=仅服务端保存的_secret_key
TURNSTILE_ALLOWED_HOSTNAMES=peerto.example.com
TURNSTILE_SOFT_LIMIT=3
TURNSTILE_WINDOW_SECONDS=600
```

如果使用 API 创建 Widget，Token 需要账户级 `Turnstile Sites Write` 权限。普通 Zone WAF 编辑权限不包含这项能力。

三个核心变量必须同时配置：

- `TURNSTILE_SITE_KEY`
- `TURNSTILE_SECRET_KEY`
- `TURNSTILE_ALLOWED_HOSTNAMES`

应用只通过 `/api/config` 下发 site key。secret 不会进入 HTML、JavaScript 或日志。服务端会调用 Siteverify，并校验 `success`、`action=create_room` 和返回的 hostname。验证失败时不会创建房间。

Turnstile token 有效时间短且只能使用一次。不要在浏览器缓存 token，也不要只做前端验证。

## WAF 规则

源站限流之外，可以在 Cloudflare 加一条扫描器拦截规则。下面是示例，域名按实际情况替换：

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

动作使用 Block。

再为高成本入口设置 Rate Limiting Rule：

```text
(http.host eq "peerto.example.com" and
 (
   (http.request.method eq "POST" and
    http.request.uri.path in {"/api/rooms" "/api/rooms/reconnect"})
   or http.request.uri.path eq "/ws"
 ))
```

一个适合小型公开实例的起点是每 IP、每数据中心 10 秒 15 次，超限后 Block 60 秒。观察真实流量后再调整。边缘阈值应略高于正常的恢复突发，应用层阈值负责更细的设备维度限制。

不要直接对 `/api/*` 或 `/ws` 使用 Managed Challenge。Challenge Page 返回 HTML，浏览器 `fetch` 会拿不到预期 JSON，WebSocket Upgrade 也会失败。需要验证码的动作由应用内 Turnstile 处理。

免费套餐的规则数量有限。如果已有规则占满，可以把 Peerto 的 host 条件合并进语义相同的扫描器或限流规则，不要覆盖其他站点的规则。

## Bot Fight Mode

不要未经验证就开启 Bot Fight Mode。它可能对 API 和 WebSocket 请求执行不可绕过的质询，免费套餐中也未必能为 Peerto 路径建立例外。Peerto 已有严格协议、源站限流、边缘限速和按需 Turnstile，先观察这些措施的效果。

## 缓存

- `/api/health` 可以短时缓存，但监控应直接检查源站或绕过缓存
- `/api/config` 按应用返回的 5 分钟缓存头处理
- `POST /api/rooms` 和 `POST /api/rooms/reconnect` 不缓存
- `/ws` 不缓存
- 带内容哈希的静态资源可以长期缓存
- HTML、Manifest 和 Service Worker 不做长期缓存

## 检查

部署后确认：

```bash
curl -i https://peerto.example.com/api/health
curl -i https://peerto.example.com/api/config
```

`/api/config` 可以包含公共 STUN 和 Turnstile site key，但不能出现 TURN 地址、TURN 密码、Turnstile secret 或服务器内部统计。

Cloudflare 当前的 Siteverify 和 CSP 要求见：

- [Server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
- [Content Security Policy](https://developers.cloudflare.com/turnstile/reference/content-security-policy/)
- [Challenge types](https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/)
