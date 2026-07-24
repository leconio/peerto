# 生产部署

[English](./deployment.md)

Peerto 只有一个应用容器。它同时提供静态页面、两个 REST 接口和临时 WebSocket 信令，不需要 Redis 或数据库。

## 前提

- Docker Engine 24 或更高版本
- Docker Compose v2
- 一个支持 HTTPS 和 WebSocket 的公网入口
- 单实例部署

WebRTC、Service Worker、文件系统 API 等浏览器能力在公网环境需要安全上下文，因此正式站点必须使用 HTTPS。

## 启动

```bash
git clone <repository-url>
cd peerto
cp .env.example .env
docker compose up -d --build
```

默认监听 `0.0.0.0:3000`。如果 TLS 入口和 Peerto 在同一台机器，建议只监听回环地址：

```dotenv
PEERTO_BIND_ADDRESS=127.0.0.1
PEERTO_PORT=3100
TRUST_PROXY=true
```

应用健康检查：

```bash
curl --fail http://127.0.0.1:3100/api/health
```

成功时只返回：

```json
{"status":"ok"}
```

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `PEERTO_BIND_ADDRESS` | `0.0.0.0` | Compose 发布端口绑定的宿主机地址 |
| `PEERTO_PORT` | `3000` | Compose 在宿主机发布的端口；容器内部固定监听 3000 |
| `ROOM_TTL_SECONDS` | `300` | 连接房间和恢复登记的 TTL |
| `MAX_PENDING_ROOMS` | `2000` | 内存中的待连接房间上限 |
| `MAX_CODE_RECORDS` | `5000` | 恢复凭证命名空间上限 |
| `MAX_CODE_MEMBERS` | `64` | 单个恢复凭证可登记的设备数 |
| `MAX_RATE_BUCKETS` | `50000` | 内存限流桶上限 |
| `RATE_LIMIT_CREATE_PER_MINUTE` | `12` | 单 IP 每分钟创建码上限 |
| `RATE_LIMIT_CREATE_PER_DEVICE_PER_MINUTE` | `6` | 单设备每分钟创建码上限 |
| `RATE_LIMIT_RECONNECT_PER_MINUTE` | `60` | 单 IP 每分钟恢复请求上限 |
| `RATE_LIMIT_RECONNECT_PER_DEVICE_PER_MINUTE` | `30` | 单设备每分钟恢复请求上限 |
| `RATE_LIMIT_WS_PER_MINUTE` | `60` | 单 IP 每分钟 WebSocket 建连上限 |
| `MAX_WS_CONNECTIONS_PER_IP` | `12` | 单 IP 同时存在的临时 WebSocket 上限 |
| `MAX_WS_MESSAGES_PER_MINUTE` | `240` | 单 WebSocket 每分钟信令消息上限 |
| `STUN_URLS` | 见 `.env.example` | 逗号分隔的公共 STUN 列表 |
| `MAX_FILE_BYTES` | `2147483648` | 前端允许的单文件大小 |
| `TRUST_PROXY` | `false` | 是否信任入口代理传递的客户端 IP |

`TRUST_PROXY=true` 只能用于受控反向代理。不要让应用端口同时绕过代理对公网开放，否则请求方可以伪造转发头，影响限流与短时 IP 绑定。

官方 Compose 只向用户暴露 `PEERTO_PORT`。容器内部的 Node 进程使用标准 `PORT=3000`，该值由 Compose 固定，不需要写进 `.env`。

Turnstile 的变量见 [Cloudflare 防护](./cloudflare.zh-CN.md)。三个核心变量都留空时，Turnstile 完全关闭。

## 入口代理

入口需要原样转发：

- `/` 和静态资源
- `/api/config`
- `/api/health`
- `POST /api/rooms`
- `POST /api/rooms/reconnect`
- `/ws` 的 WebSocket Upgrade

代理层不要缓存 REST 写请求和 WebSocket。`/api/config` 可以按应用返回的缓存头处理，带哈希的前端资源可以长期缓存。

Cloudflare Tunnel 的示例在 [Cloudflare 防护](./cloudflare.zh-CN.md)。如果使用 Nginx，请确认 `/ws` 转发了 `Upgrade` 与 `Connection` 请求头。

## 更新与回滚

应用没有数据库迁移。更新前仍应保留上一份镜像：

```bash
docker image tag peerto:local peerto:rollback
git pull --ff-only
docker compose build
docker compose up -d
```

检查失败时可以把 Compose 中的镜像临时改为 `peerto:rollback` 后重新启动。浏览器端协议不承诺兼容旧版本，生产更新时应避免新旧应用实例同时对外服务。

## 上线前检查

```bash
npm ci
npm run check
docker compose config --quiet
docker compose up -d --build
curl --fail http://127.0.0.1:3000/api/health
BASE_URL=http://127.0.0.1:3000 npm run acceptance
```

还需要确认：

- 应用端口没有直接暴露到公网
- HTTPS 证书有效，WebSocket 能升级
- 日志没有连接码、凭据、SDP 或 ICE 内容
- `.env`、TURN 配置、证书和私钥均未提交到 Git
- Cloudflare 或入口代理有独立的请求限速
- 只有一个 Peerto 应用实例在处理会合状态
