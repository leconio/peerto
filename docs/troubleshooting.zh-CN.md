# 连接问题排查

[English](./troubleshooting.md)

## 一直显示无法建立直连

常见原因有：

- 双方都在对称 NAT 后
- 运营商使用 CGNAT
- 公司或校园网络限制 UDP
- 两台设备在同一出口 NAT 后，但路由器不支持 hairpin
- 防火墙丢弃 WebRTC 使用的随机 UDP 端口
- 公共 STUN 在当前网络不可达

先在设置中保留 UDP 和 TCP 两种 TURN URL，再重新进入会话。如果顶部显示“中继连接”，说明直连失败后已经使用 TURN。

STUN 只帮助发现地址，不转发数据。增加更多 STUN 不能解决所有 NAT 问题。

## 两台设备在同一局域网仍然连不上

浏览器通常会收集 host Candidate，但 mDNS、访客 Wi-Fi 隔离、AP Client Isolation 和主机防火墙都可能阻止互访。

可以逐项检查：

1. 两台设备是否能在局域网直接访问彼此。
2. Wi-Fi 是否开启了客户端隔离。
3. VPN 是否改写默认路由。
4. 浏览器是否允许 WebRTC。
5. 防火墙是否允许浏览器的 UDP 流量。

已配对设备可以设置自定义 IP。这个功能仍需要两台设备之间真实可路由，也仍需要 Peerto WebSocket 完成 SDP 交换。它不会固定浏览器随机选择的 UDP 端口。

## 连接码生成成功，但另一台设备找不到主机

连接码绑定主机访问 Peerto 服务时的来源 IP。主机从 Wi-Fi 切换到移动网络、VPN 上下线或出口 IP 变化后，旧房间会失效。关闭旧弹窗并重新生成连接码。

检查两台设备的系统时间、HTTPS 证书和 WebSocket。反向代理必须正确处理 `/ws` Upgrade。

## 刷新后无法恢复

恢复需要双方仍保存：

- 同一配对码命名空间
- 相同的高熵恢复令牌
- 自己的 P-256 私钥
- 对方的设备身份

双方都打开对应会话时，第一个设备登记等待，第二个设备加入。如果清过站点数据、使用隐私模式或浏览器回收了存储，需要重新配对。

## 手机接收文件失败

Peerto 优先把接收数据流式写入 OPFS，不要求 Android 先创建目标文件。检查：

- 浏览器可用磁盘空间
- 站点存储权限和配额
- 页面是否在传输中被系统挂起
- 两端是否保持在前台
- 文件是否超过 `MAX_FILE_BYTES`

浏览器不支持 OPFS 时会退回内存和普通下载。大文件在该模式下更容易被系统终止。

当前协议不支持断点续传。传输中刷新、断网或关闭页面后，需要重新发送文件。

## TURN 配置后没有看到 relay

只要直连可用，ICE 选择直连是正常的。确认 TURN 是否参与可以查看：

- Chrome 的 `chrome://webrtc-internals`
- Firefox 的 `about:webrtc`
- coturn 容器日志

如果没有 relay Candidate，检查 TURN 域名、端口、传输类型、用户名、密码、防火墙和 `external-ip`。TURN 主机在 NAT 后时，relay 端口范围必须一对一映射。

## 页面出现人机验证失败

Turnstile token 有效时间短且只能使用一次。刷新页面后重试。如果持续失败，站点运营者应检查：

- Widget 是否允许当前 hostname
- 服务端的 site key 和 secret 是否属于同一个 Widget
- `TURNSTILE_ALLOWED_HOSTNAMES` 是否包含当前域名
- CSP 是否允许 `https://challenges.cloudflare.com`
- 服务端是否能访问 Siteverify

不要把 Turnstile secret 发到 Issue。

## 收集诊断信息

提交 Issue 时可以附上：

- 浏览器名称与版本
- 操作系统
- 两端网络类型，例如家庭 Wi-Fi、移动网络或公司网络
- 页面显示的连接阶段和错误码
- 是否配置 TURN
- 能否在其他网络重现

不要附上：

- 连接码或分享链接
- 恢复令牌
- TURN 密码
- Turnstile secret
- 完整 SDP、ICE Candidate 或真实 IP
- 浏览器站点存储导出
