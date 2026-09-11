---
description: "Add experimental SSH remote workspaces to a source-checkout Web profile."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-remote-host-web-profile

[English](README.md) | 中文

## 概述

`dsh-experimental-remote-host-web-profile` 是远程 SSH/Tailscale 工作区的私有 Web 层。在 `dsh-web-app` 之后加入，以便 Host 挂载 SSH 路由器，浏览器显示带机器标签的项目。正式发行不含此包。

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

在本仓库 checkout 中，用 source overlay，这样不必把私有包装进 profile：

```sh
pnpm dsh web --patch ./packages/experimental/remote-host-web-profile/source.cordis.patch.yml
```

`dsh plugin --profile web add ./packages/experimental/remote-host-web-profile` 是持久安装路径；它在 `$DSH_HOME/profiles/web` 里运行 `pnpm add`，若该 profile 已依赖未发布的 registry 包则会失败。设置 → 插件列出远程主机；侧栏底部出现添加远程项目。不同机器上的同名文件夹会显示不同的机器标签。

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>实现内部 — 点击展开</summary>

该补丁把 `fs-sandbox` 行替换为 `@deepseek-ai/dsh-experimental-remote-host`，禁用 `subprocess` 行以免第二次注册 `ctx.subprocess`，并插入 Client UI。路由器仍在隔离 scope 上为没有 `machineId` 的会话构造沙箱化本地后端。

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [remote-host](../remote-host/README.zh.md)

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a profile bundle that mounts remote-host plugins and registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **替换本地 fs/subprocess 行** — bundle 禁用库存本地提供者，依赖路由器为本地会话重新实例化它们。
- **仅源码 checkout** — 正式发行载荷不含此私有包。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

None.

</details>
