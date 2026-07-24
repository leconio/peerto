# 参与 Peerto

[English](./CONTRIBUTING.en.md)

感谢你愿意花时间改进 Peerto。提交代码前，请先确认改动仍然符合项目边界：消息和文件不经过应用服务器，没有账号系统，没有数据库，也不引入常驻在线目录。

## 报告问题

普通 Bug 可以提交 Issue。请写清楚浏览器、系统、两端网络类型、复现步骤和页面错误码。

不要粘贴连接码、分享链接、恢复令牌、TURN 密码、Turnstile secret、真实 IP、完整 SDP 或 ICE Candidate。安全问题请按 [SECURITY.md](./SECURITY.md) 私下报告。

## 开发环境

需要 Node.js 22 或更高版本：

```bash
npm install
npm run dev
```

前端默认运行在 5173，API 和 WebSocket 代理到 3000。

## 提交改动

1. 为 Bug 修复或协议变更补测试。
2. 前后端共享字段先改 `packages/protocol`。
3. 用户可见文案同时更新中文和英文。
4. 不提交 `.env`、TURN 配置、证书、私钥和抓包内容。
5. 不保留旧协议兼容分支，除非维护者明确决定改变当前策略。
6. 更新与改动直接相关的文档，并同步中文 `.md` 与英文 `.en.md`。

提交前运行：

```bash
npm run check
docker compose config --quiet
```

涉及 WebRTC 的改动还应至少用两个独立浏览器测试首次连接、恢复连接和断开处理。涉及文件传输时，测试空文件、小文件、大文件取消和移动端接收。

## Pull Request

PR 描述应包含：

- 改了什么
- 为什么需要改
- 如何验证
- 是否改变本地存储、共享协议、隐私边界或部署配置

请把一个 PR 控制在一个主题内。大规模重构最好先开 Issue 说明目录和协议影响。
