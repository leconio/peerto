# 部署和使用 TURN

[English](./turn.en.md)

Peerto 使用标准 `RTCIceServer` 配置，不依赖某个 TURN 提供商。coturn、云厂商 TURN 和其他兼容服务都可以替换。

默认构建只带公共 STUN。仓库、Docker 镜像、`/api/config` 和前端脚本中都不包含项目维护者自己的 TURN 地址、端口、用户名或密码。

## TURN 地址能否隐藏

不能对实际使用它的浏览器隐藏。浏览器必须知道 TURN 地址和凭据才能建立 relay Candidate，网络观察者也能看到连接目标。

这里的“不暴露”指：

- 不把私人 TURN 写进仓库、示例、镜像或公开 API
- 不把凭据放进前端构建变量
- 只在需要的浏览器设置页中填写
- 定期更换凭据，并用配额和带宽限制控制滥用

更换成不常见的域名或端口只能减少无目的扫描，不能替代认证、限流和防火墙。

## 用 Docker 启动 coturn

仓库提供了一个独立 Compose：

```bash
cd deploy/coturn
cp turnserver.conf.example turnserver.conf
```

生成一个随机密码：

```bash
openssl rand -base64 36
```

编辑本机的 `turnserver.conf`：

1. 把 `external-ip` 改为服务器公网地址。
2. 把 `realm` 改为 TURN 域名。
3. 替换 `CHANGE_ME_WITH_A_LONG_RANDOM_PASSWORD`。
4. 没有 IPv6 时删除 `listening-ip=::`。
5. 如果服务器在 NAT 后面，按 coturn 文档使用 `公网IP/内网IP` 形式的 `external-ip`。

`turnserver.conf` 已被 `.gitignore` 排除。不要把实际配置复制到 Issue 或日志附件。

启动：

```bash
docker compose up -d
docker compose logs --tail=100 coturn
```

示例镜像使用固定版本，不跟随 `latest`。升级前查看 coturn 发布说明，再单独更新镜像标签。

## 防火墙

示例配置需要放行：

- UDP 3478
- TCP 3478
- UDP 49160 至 49200
- 使用 TURN over TLS 时再放行 TCP 5349

监听端口可以调整，但 `min-port` 到 `max-port` 的 relay UDP 范围必须一并放行。Cloudflare Tunnel 和普通 HTTP 反向代理不能转发 TURN 的通用 UDP 流量，TURN 应直接使用公网 UDP，或使用支持该协议的四层代理。

如果 coturn 主机本身位于 NAT 后面，路由器必须保持 relay 端口的一对一映射。只映射 3478 不够。

## 浏览器里的配置

Peerto 设置页接受多行 STUN 和 TURN URL。多条 TURN URL 共用一组用户名和密码。

常见写法：

```text
turn:turn.example.com:3478?transport=udp
turn:turn.example.com:3478?transport=tcp
turns:turn.example.com:5349?transport=tcp
```

其中：

- `turn:` 可以使用 UDP 或 TCP
- `turns:` 表示 TURN over TLS
- UDP 通常延迟更低
- TCP/TLS 可以覆盖一部分严格限制 UDP 的网络

STUN 和 TURN 不会互相抢占。ICE 会检查所有 Candidate Pair，通常优先选择 host 或 server-reflexive 直连，直连不可用时再选择 relay。最终路径以会话顶部显示的连接类型为准。

连接已经走中继时，Peerto 默认由主机按退避间隔发起 ICE restart，重新收集候选并尝试切换到直连。重新协商通过现有的加密 DataChannel 完成，不依赖应用服务器继续保留信令状态。正在传输文件时会延后自动尝试。

设置中的“仅使用中继”会使用浏览器标准的 `iceTransportPolicy: "relay"`。启用后只收集 TURN relay 候选，并停用上述直连升级策略。这个模式适合测试 TURN，或明确要求隐藏本地直连候选的网络；它会增加 TURN 带宽消耗和传输延迟。

## TLS

需要 `turns:` 时，在 coturn 配置中增加：

```text
cert=/etc/coturn/certs/fullchain.pem
pkey=/etc/coturn/certs/privkey.pem
```

证书目录已经在 `.gitignore` 中。挂载证书时保持只读，并确保容器用户可以读取。证书域名必须与 `turns:` URL 一致。

## 防滥用

示例配置做了几件事：

- 使用 long-term credential
- 限制总 allocation 和单用户 allocation
- 限制每个 allocation 的带宽
- 关闭管理 CLI
- 禁止 relay 访问私网、回环和组播地址
- 使用较小的 relay 端口范围，方便防火墙精确放行

公共 TURN 不应长期共用一个静态账号。如果访问量增加，建议使用 coturn 的 TURN REST 认证方式签发短期 HMAC 凭据。签发服务可以独立部署，Peerto 仍只消费标准 URL、username 和 credential，不需要改动信令协议。

静态凭据泄露后应立即轮换：

1. 生成新密码并更新 coturn。
2. 重启 coturn。
3. 在需要使用的浏览器中更新设置。
4. 检查 allocation 数量、出口带宽和异常来源。

## 验证

先看 coturn 是否正常监听和分配 relay：

```bash
docker compose ps
docker compose logs --tail=100 coturn
```

再用两台不在同一局域网的设备连接。会话页显示“中继连接”时，说明 ICE 选择了 TURN。浏览器的 `chrome://webrtc-internals` 或 Firefox `about:webrtc` 也可以确认选中的 Candidate Pair 是否包含 `relay`。

如果始终直连，这是正常结果。需要确认 TURN 可用性时，可以临时开启“仅使用中继”，验证完成后再关闭。

coturn 的完整选项和安全说明以 [coturn 官方配置](https://github.com/coturn/coturn/blob/master/docker/coturn/turnserver.conf) 为准。
