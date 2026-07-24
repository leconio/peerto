# Peerto 工程架构

[English](./ARCHITECTURE.en.md)

Peerto 使用 npm workspaces 管理前端、服务端与共享协议。目录按运行边界和业务职责划分，入口文件只做组合，不承载具体业务实现。

## Workspace

```text
peerto/
├── apps/
│   ├── web/                 React PWA
│   └── server/              Fastify 静态资源、REST 与临时 WSS
├── packages/
│   └── protocol/            前后端共享协议、Schema 与文件帧格式
├── scripts/                 验收与网络诊断脚本
├── Dockerfile
└── compose.yaml
```

## Web

```text
apps/web/src/
├── App.tsx                  页面组合与顶层状态装配
├── main.tsx                 React、PWA、i18n 启动入口
├── components/              无业务归属的通用 UI
├── features/
│   ├── chat/                对话面板
│   ├── connection/          连接码、分享连接与建链动作
│   ├── conversations/       左侧会话列表
│   ├── messages/            消息流、回复、置顶与消息动作
│   ├── resources/           本机资源预览、下载与删除
│   ├── retry/               会话恢复与退避重试
│   ├── security/            按需 Turnstile 验证
│   ├── session/             多 Peer 客户端池、事件作用域与 UI 状态适配
│   ├── settings/            设置界面
│   └── transfers/           文件选择、进度与传输 UI 适配
├── hooks/                   与业务无关的 React hooks
├── lib/                     纯函数、浏览器能力和本机持久化
├── locales/                 中英文资源
├── services/
│   └── peer/                WebSocket/WebRTC 会话状态机及公开类型
├── store.ts                 本机持久状态
└── styles/                  共享应用视觉契约
```

依赖方向：

```text
main → App → features/components
                 ↓
          services/lib/store
                 ↓
              protocol
```

- `App.tsx` 只装配状态、feature hooks 和页面区块，不定义大段 UI。
- feature 内部可以依赖通用组件、服务、lib 和 store，但不能反向依赖 `App.tsx`。
- WebRTC、WSS、ICE 和文件传输协议集中在 `services/peer`，React 组件不直接操作底层连接。
- 每个已连接设备拥有独立 `PeerClient`。配对客户端与设备会话客户端分离，切换 UI 会话不会复用同一个连接。
- 设备会话客户端数量默认上限为 4，可在本机配置为 1 至 32；达到上限时先回收最久未使用的离线客户端，再断开最久未使用且不是当前会话的在线客户端。进入已回收会话时按需重新创建。
- 自定义 IP 仅保存在对应 `KnownPeer` 的本机状态中；`PeerClient` 在该设备的连接内禁用 ICE Server，并在浏览器端改写对端 host Candidate。
- ICE 设置把多条 TURN URL 组装为一个标准 `RTCIceServer`，共享一组用户名和密码；TURN 服务仍独立于应用部署。
- 会话双端删除通过已认证的 `control` DataChannel 请求和结果消息协调。`features/conversations` 保证先等待远端成功，再提交本地删除；`store` 严格清理消息、资源与配对状态，清理失败不会报告删除成功。
- 文案只放在 `locales`；业务模块使用翻译 key。
- `styles/ui.module.css` 是当前单一视觉契约，避免结构重构时产生样式漂移；全局主题和浏览器基线位于 `styles.css`。

## Server

```text
apps/server/src/
├── index.ts                 进程启动、监听与退出
├── app.ts                   Fastify 应用组合根
├── config/                  环境变量解析与运行配置
├── plugins/                 安全头与 WebSocket 插件
├── routes/                  REST API 和静态 PWA 资源
├── security/                设备签名、身份校验与 Turnstile
├── signaling/               临时 WSS 房间状态机和消息转发
└── storage/                 有界 TTL 内存房间仓库
```

依赖方向：

```text
index → app → plugins/routes/signaling
                         ↓
                security/storage/config
                         ↓
                      protocol
```

- `app.ts` 只创建依赖并注册插件、路由和信令。
- REST 路由不维护 WebSocket 运行时状态。
- 信令模块不承载静态资源和普通 HTTP 路由。
- 所有短时状态由 `RoomStore` 管理；业务模块不能另建无上限的全局 Map。
- REST 写请求按 IP 和设备身份分别限流，并校验浏览器 Origin。
- WebSocket 按 IP 限制连接频率、并发数和单连接消息速率。
- Turnstile 只保护超过软阈值的创建码请求；secret 只存在于服务端。
- 服务端永远不接触消息正文和文件内容。

## 测试与改动规则

- 纯函数和状态机测试与实现文件就近放置。
- `apps/server/src/app.test.ts` 做服务端黑盒协议与安全边界测试。
- `scripts/acceptance.mjs` 验证构建后的公网/容器运行行为。
- 新业务优先放入对应 `features` 或服务模块；只有跨领域装配才进入 `App.tsx` 或 `app.ts`。
- 新的前后端共享字段必须先进入 `packages/protocol`，禁止各自复制类型。
