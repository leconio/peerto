# 更新记录

[English](./CHANGELOG.en.md)

本项目仍处于早期阶段。发布版本后，从最新版本开始按日期记录用户可见变化。

## Unreleased

### Added

- 开源许可证、贡献指南、安全策略和部署文档
- 独立 coturn Compose 与安全配置示例
- 创建码按需 Turnstile 验证
- REST、设备和 WebSocket 的分层限流
- CI、依赖更新和密钥扫描配置

### Security

- 公共健康检查不再返回房间数量
- TURN 地址与凭据不进入默认配置、公开 API 或前端构建
- 创建与恢复接口增加同源检查
