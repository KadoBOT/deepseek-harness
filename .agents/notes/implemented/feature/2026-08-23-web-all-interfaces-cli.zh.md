# Agent Note: CLI 全接口 Web 服务

Status: implemented

[English](2026-08-23-web-all-interfaces-cli.md) | 中文

## 问题

[显式 Web 绑定地址](2026-07-22-web-bind-address.zh.md)决策将 `--host 0.0.0.0` 定名为 `dsh web` 的显式全接口模式，HTTP 载体的 schema 与 [`/api` 浏览器信任围栏](../architecture/2026-07-28-api-browser-trust-boundary.zh.md)也都支持该部署形态：围栏接受从本机网卡推导出的、不带端口的 LAN IP 字面量。但 CLI 对通配取值仍以用法错误退出，导致局域网浏览器只能通过手写补丁层覆盖 webserver 行才能访问 GUI，没有任何受支持的路径。

## 决策

`dsh web --host` 只接受 `127.0.0.1` 与 `0.0.0.0`；其他任何取值都会在任何服务行求值之前以用法错误退出。全接口模式继续打印带 token 的 loopback URL，并追加首个采样到的非 internal IPv4 URL，后者同样需要浏览器凭据。本次调用的 IP 字面量经 `webRuntime` 以不带端口的形式送达信任围栏，与显式 `--trusted-host` 条目并列。

单独的 [`--allow-unauthenticated-network` 决策](../architecture/2026-09-03-trusted-network-browser-authentication.zh.md)只允许派生的 RFC 1918 与 Tailscale 套接字对等端省略该凭据。它要求显式全接口 host，并会打印干净网络 URL，而 loopback 仍携带 token。

## 曾考虑的替代方案

**继续拒绝通配取值，要求用手写补丁层实现局域网访问。** 不予采纳，因为已发布的命令无法表达其自身绑定地址决策所指名的网络模式，迫使运维者为覆盖一行配置而做组合手术。

**要求先显式声明 `--trusted-host` 才允许 LAN 请求通过围栏。** 不予采纳，因为暴露选择本就由绑定 flag 做出，而 DHCP 重新分配会让手打的清单静默失效；从本机采样得到的、不带端口的 IP 字面量才是围栏重绑定防御真正需要的形态。

## 后果

绑定 flag 会把 HTTP 服务器暴露到每个可达接口，而 Connection 的 Host 围栏与浏览器会话仍保护 Host API 与 WebSocket 访问。显式可信网络 flag 可以通过明文 HTTP 向匹配的私有对等端授予完整工具权限；绑定与认证仍是运维者的两个独立选择。接口采样只在激活时进行一次，之后新增的地址需要重启或声明 authority。自定义接口地址与 IPv6 绑定在 CLI 与载体 schema 两处仍不受支持。
