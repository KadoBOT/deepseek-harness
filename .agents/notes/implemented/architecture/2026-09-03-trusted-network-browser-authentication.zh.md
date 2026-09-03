# Agent Note: 无需启动 token 的可信网络浏览器访问

Status: implemented

[English](2026-09-03-trusted-network-browser-authentication.md) | 中文

## 问题

[`dsh web --host 0.0.0.0`](../feature/2026-08-23-web-all-interfaces-cli.zh.md) 会绑定每个 IPv4 接口，并把采样到的接口地址加入浏览器信任 Host 允许清单，但[浏览器会话认证](2026-08-24-browser-token-authentication.zh.md)仍要求索引 HTML、HTTP API 调用和 WebSocket 升级先用启动 token 换取绑定 authority 的 cookie。把此模式称为无认证掩盖了绑定与认证是两个独立选择，而通过 Tailscale IP 直接发出的请求能到达服务器，却会停止在 401。

Tailscale MagicDNS 名称会到达同一套接字，却不属于采样所得的 IP 字面量 authority。其 index 请求过去可以交换 token，因为普通 index 认证不应用 Host 围栏；随后页面的 HTTP API 和 `/api/remote.mux` WebSocket 请求会在该围栏以 403 失败。结果看起来像页面成功登录后的传输故障，而不是缺少 `--trusted-host` 声明。

运维者需要一种显式模式，使直连私有 LAN 或 Tailscale 网络中的对等端无需复制进程 token 就能使用 Web 应用。loopback 使用必须保留现有 token 流程，而且该模式不能把所有能路由到全接口套接字的对等端都变成已认证调用方。

## 决策

`dsh web` 仅在同时显式设置 `--host 0.0.0.0` 时接受 `--allow-unauthenticated-network`；其他组合会在 Web 行激活前以用法错误退出。设置该 flag 却无法派生任何合格接口规则时，启动会给出包含修正方式的错误。

`dsh-web-app` 在服务器绑定后对 `node:os.networkInterfaces()` 采样一次，并生成与 `trustedHosts` 分离的源地址与目标地址规则。仅当接口前缀能让子网保持在对应 RFC 1918 地址块内时，RFC 1918 IPv4 接口才会贡献其本地地址与该接口子网组成的配对。本地地址处于 Tailscale 的 `100.64.0.0/10` 范围时，会贡献该本地地址与完整 Tailscale IPv4 范围组成的配对。公网、链路本地、loopback、格式错误及 IPv6 条目不会贡献无认证规则；当前 Web carrier 仅绑定 IPv4。现有非内部 IPv4 字面量列表仍作为 Host 允许清单与 URL 展示输入。

Connection 使用实际套接字中已规范化的 `localAddress` 与 `remoteAddress` 匹配规则，并支持 IPv4 映射的 IPv6 形式。仅当两个地址都匹配同一规则时，请求才会绕过浏览器会话认证。缺失套接字事实、目标地址不匹配、源地址不在子网内以及 loopback 都会继续进入启动 token 与 cookie 流程。Connection 绝不会读取 `Forwarded`、`X-Forwarded-For` 或其他代理声明。

任何网络绕过之前仍必须通过 Host／Origin／跨站浏览器信任围栏。`/api` HTTP 请求与 `/api/remote.mux` WebSocket 升级使用同一拒绝决策。来自匹配网络对等端的干净 index 请求要先通过同一围栏，前端才能被提供；此类请求若携带 token 查询参数，会重定向到干净 URL 而不保留进程 token。因此，即使对等端受信任，MagicDNS authority 仍需要显式 Host 声明：

```sh
dsh web --host 0.0.0.0 --allow-unauthenticated-network \
  --trusted-host olares-1.hake-skink.ts.net
```

启动行会保留带 token 的 loopback URL，因为 loopback 仍需认证。它会为首条派生规则打印干净的 `LAN/Tailscale` URL，并说明只有检测到的 LAN 与 Tailscale 对等端会绕过认证。未使用该 flag 时，每个打印 URL 仍携带 token，警告则描述需要认证的全接口服务。

本决策部分取代浏览器会话认证的统一 cookie 规则及其拒绝把 TCP 对等端地址用作身份的决定。token 仍是 loopback、不匹配对等端、由 loopback 代理传递的流量以及未使用该 flag 的全接口启动所采用的身份。Host 与 Origin 仍是路由证据和防范 confused deputy（混淆代理）攻击的措施，而不是身份。

## 验证

Connection 单元测试固定规则校验、普通地址与 IPv4 映射地址的规范化、目标加源地址匹配、loopback 拒绝、干净 index 重定向以及 Host 围栏顺序。真实 HTTP 与 WebSocket Host 测试会绑定全接口服务器，并证明匹配对等端无需 cookie 即可成功，同时 loopback 仍返回 401，不可信 Host 仍返回 403。Web 组合包测试固定 CLI 校验、接口分类、安全子网派生、运行时接线、干净网络输出与带 token 的 loopback 交接。构建后的 `dsh` CLI 测试会通过打印出的非 loopback 地址连接，并证明 index 与 API 访问不会削弱 loopback 或 Host 拒绝。

## 考虑过的替代方案

**要求显式源 CIDR。** 可重复的 `--allow-unauthenticated-from <cidr>` 选项很精确，也支持少见的路由网络，但会使常见的私有 LAN 与 Tailscale 场景依赖手工地址计算。随附 flag 有意只支持启动时能从直连接口派生的范围。

**让每个全接口请求绕过认证。** 绑定与认证是相互独立的选择。把 `--host 0.0.0.0` 当作身份会把操作系统用户的工具权限授予每个可路由对等端，也会让显式安全 flag 失去意义。

**把 `trustedHosts` 当作已认证身份。** `Host` 由客户端提供，既不能证明套接字来源，也不能证明 Tailscale 成员身份。复用它进行认证会让非浏览器调用方伪造受允许 authority，并把现有 DNS 重绑定围栏压缩成它本就无意承担的身份检查。

**自动发现并信任 MagicDNS。** 调用 Tailscale CLI 或解析可变 DNS 名称会增加可选外部依赖和第二套发现生命周期。现有 `--trusted-host` 选项会显式声明 authority，而新 flag 只处理对等端认证。

## 后果

派生规则接纳的每个对等端都会获得具备完整工具能力的 Host 权限。套接字地址是路由事实，而不是密码学身份；普通 HTTP 无法抵御路径上网络参与者的窃听或篡改。Tailscale 地址范围也可能存在于非 Tailscale 的运营商级 NAT 环境；要求本地目标处于同一范围可以缩小风险，却不能证明使用了 Tailscale 传输。

接口采样是启动时快照。地址、路由或 VPN 变更需要重启，转发标头绝不会扩大实际套接字策略。这些限制让代理身份与动态网络发现留在本决策之外。

浏览器 token、浏览器信任与全接口 Agent Note 会保持活跃。它们各自保留独立有用的安全理由，而本决策只交叉链接并部分取代其中的统一认证与无认证服务说法。
