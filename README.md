# Peerto

[English](./README.en.md)

Peerto 是一个浏览器里的点对点消息和文件传输工具。界面接近常见的聊天应用，但它不是聊天室：消息和文件通过 WebRTC DataChannel 在设备之间传输，应用服务器只负责页面、短时连接码和建链信令。

## 能做什么

- 使用 6 位短时连接码配对两台设备
- 使用分享链接直接连接，无需再次确认
- 配对后保存设备身份，进入会话时自动恢复连接
- 一个浏览器同时保持多个设备连接，默认上限为 4
- 发送文本、原图、视频和其他文件
- 回复、置顶和删除自己发送的消息
- 文件分块传输并写入浏览器本地存储
- 在资源页预览、下载或删除本机文件
- 配置多个 STUN、多个 TURN、仅中继模式或单个设备的自定义 IP
- 安装为 PWA，支持手机布局、中英文和深浅色主题

每个会话仍是 1 对 1。Peerto 没有账号系统、群聊、云端历史、离线消息和设备在线目录。

## 数据放在哪里

消息记录和配对信息保存在当前浏览器。设备私钥与文件句柄使用 IndexedDB，接收的文件使用 OPFS。应用服务器不保存消息正文和文件内容。

服务器在建链期间会处理连接码、设备公钥、来源 IP、SDP 和 ICE Candidate。这些状态有容量上限和短 TTL，P2P 建立后会被删除。详细说明见 [隐私说明](./docs/privacy.md)。

## 快速启动

需要 Docker 和 Docker Compose：

```bash
cp .env.example .env
docker compose up -d --build
```

打开 `http://localhost:3000`。公网部署必须提供 HTTPS 和 WSS，可以使用现有的反向代理或 Cloudflare Tunnel，不要求安装 Caddy。

默认只内置公共 STUN，不内置任何 TURN 地址或凭据。TURN 可以在设置页填写，也可以按 [TURN 部署说明](./docs/turn.md) 自建。连接走 TURN 时，默认会按退避策略重新协商并尝试切换到直连；需要固定走 TURN 时可开启“仅使用中继”。

## 本地开发

需要 Node.js 22 或更高版本：

```bash
npm install
npm run dev
```

提交改动前运行：

```bash
npm run check
```

项目使用 npm workspaces：

```text
apps/web/          React PWA
apps/server/       Fastify 静态资源、API 和临时 WebSocket 信令
packages/protocol/ 前后端共享的 Schema 与协议类型
deploy/            部署示例
docs/              运维与安全文档
```

## 部署文档

- [Docker 与生产部署](./docs/deployment.md)
- [部署和使用 coturn](./docs/turn.md)
- [Cloudflare Tunnel、限流与 Turnstile](./docs/cloudflare.md)
- [常见连接问题](./docs/troubleshooting.md)
- [工程结构](./ARCHITECTURE.md)
- [需求与协议边界](./REQUIREMENTS.md)

## 参与项目

问题和改动建议请先看 [CONTRIBUTING.md](./CONTRIBUTING.md)。安全问题不要提交公开 Issue，请按 [SECURITY.md](./SECURITY.md) 中的方式报告。

## 许可证

[MIT](./LICENSE)
