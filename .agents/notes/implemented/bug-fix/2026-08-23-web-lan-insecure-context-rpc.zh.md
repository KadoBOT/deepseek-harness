# Agent Note：浏览器 RPC 在不安全局域网源上可用

Status: implemented

[English](2026-08-23-web-lan-insecure-context-rpc.md) | 中文

## Problem

[Web 全接口服务](../feature/2026-08-23-web-all-interfaces-cli.zh.md)决策暴露了一个潜在的载波缺陷：通过普通 HTTP 从非回环地址加载的页面处于**不安全上下文**，浏览器将 `crypto.randomUUID` 限制在安全上下文中——而回环源始终是安全的，因此所有回环会话都掩盖了这个缺陷。`AbstractApiClient.mintRpcId()` 直接调用它，导致通过 LAN IP 访问时每个一元 RPC 在写出请求之前就抛出异常，`ConnectionController` 随之中止每一代两个正在连接的下行套接字（表现为 1006 关闭和无限重连警告），GUI 完全无法加载数据。ui-conversation 的草稿附件 id 生成对图片附件也有同样的依赖。

## Decision

fetch 载波通过一个辅助函数生成 id：存在 `crypto.randomUUID` 时直接使用，否则从 `crypto.getRandomValues` 派生 RFC 4122 version 4 UUID——后者在浏览器的非安全源上同样可用；该辅助函数保持为 apiproxy 客户端的模块私有实现。ui-conversation 为草稿附件 id 携带同样的包内私有生成逻辑，而不是按照客户端导出纪律去扩大任何插件的公共导出面。仅限回环的特权方法（凭据管理）保持不变，设计上依然不可从非回环页面触达。

## Alternatives considered

**要求 HTTPS 或反向代理才能进行局域网访问。** 否决，因为已交付的全接口模式承诺在可信网络上以普通 HTTP 提供局域网使用；TLS 终止是运营者的部署选择，不是载波前提。

**导出现有的 connection 包 UUID 辅助函数并在各处导入。** 否决，因为客户端插件之间禁止跨包值导入是导出纪律的规定；为一个辅助函数扩大 connection 的 `./client` 入口等于用边界规则换取便利。

**让局域网服务依赖此修复或回退绑定 flag。** 否决，因为缺陷在载波的平台假设里，而不在绑定决策中；回环服务只是掩盖了它。

## Consequences

每个浏览器 bundle 现在以每个生成点一条代码路径同时工作于安全与非安全源；Node 调用方继续走原生 `randomUUID` 分支。回归测试删除 `crypto.randomUUID` 并断言一元调用仍能生成有效的 version 4 id。未来任何浏览器代码若使用 `crypto.randomUUID`、`crypto.subtle` 或其他仅限安全上下文的 API，都会重新引入这类仅在回环下才可见的故障，需要同样的降级处理。
