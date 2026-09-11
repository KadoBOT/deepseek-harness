---
description: "Web UI to register SSH/Tailscale machines and add their projects from the sidebar."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-remote-host

[English](README.md) | 中文

## 概述

`dsh-experimental-client-ui-remote-host` 是远程工作区的浏览器半边：在插件设置卡片中添加 SSH 或 Tailscale 主机，并在侧栏底部把所选机器上的目录登记为项目。正式发行不含此包。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

与 [`remote-host-web-profile`](../remote-host-web-profile/README.zh.md) 一起挂载。侧栏底部出现 **添加远程项目**；设置 → 插件显示 **远程主机**。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>实现内部 — 点击展开</summary>

插件注册到键为 `remote-hosts` 的 `settings.plugin.item`，以及 `sidebar.footer.action`。它调用 `ctx.remote.remoteHosts`，不覆盖工作区浏览器；项目行上的机器标签来自 WorkspaceView。

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [remote-host](../remote-host/README.zh.md) — 宿主登记与 SSH 执行路由器。

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side UI plugin layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **目录列举，不是 Miller 选择器** — 添加流程通过 SSH 列出远程目录；它不是库存的本地文件夹对话框。
- **仅源码 checkout** — 正式发行载荷不含此私有包。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

None.

</details>
