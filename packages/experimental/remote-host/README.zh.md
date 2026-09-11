---
description: "Experimental DSH-to-DSH machine registry and execution-world router so one dsh web process can open projects that live on another DSH on the same machine or Tailscale LAN."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-remote-host

[English](README.md) | 中文

## 概述

`dsh-experimental-remote-host` 让主 `dsh web` 进程访问同一台电脑或同一 Tailscale 局域网里的另一台 `dsh web`：按 URL 登记该 DSH、浏览其上的目录，并把它登记为带该机器标签的 Workspace。从这些 Workspace 打开的会话经宿主平面 fs/subprocess/shell 路由器在对方机器上运行文件与 shell 工具，不需要 ssh 或 Python。正式发行不含此包。

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

从本 checkout 叠加 source overlay（私有包留在仓库里，不必装进 profile）：

```sh
pnpm dsh web --patch ./packages/experimental/remote-host-web-profile/source.cordis.patch.yml
```

每个主机都是一台 `dsh web` 的 base URL：本机开发用 `http://127.0.0.1:3081`，Tailscale 局域网用 `http://gpu.tailnet.ts.net:3080`。对方以 `dsh --profile web --host 0.0.0.0 --port 3080 --no-open` 启动（默认即信任 Tailscale 对端，无需 token）。保存主机后，侧栏底部的 **添加远程项目** 选择机器和目录；该 Workspace 会出现在侧栏，标题旁带机器标签。

两台机器运行同一个 overlay 即可互相发现：每个实例在局域网（UDP 组播）和 tailnet（向 `tailscale status` 对端单播）广播自己的 URL，对收到的广播做网关校验，通过的自动登记，无需粘贴任何地址。发现默认开启：

```yaml
- id: remote-host
  name: '@deepseek-ai/dsh-experimental-remote-host'
  config:
    discovery:
      enabled: true   # false opts out; manual hosts keep working
      port: 43771     # UDP discovery port shared by all peers
      intervalMs: 5000
```

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>实现内部 — 点击展开</summary>

本包挂载 `ctx.remoteHosts`，以及占据 `ctx.fs`、`ctx.subprocess` 与 `ctx.shell` 的路由器。本地会话保留隔离的本地后端，它们构造在隔离的 Cordis scope 上，以免与路由器冲突。header 带 `machineId` 的会话被路由到对方 DSH 网关：文件经 `remoteHosts/local*` 远端调用，shell 命令以 `bash -c` 经路由后的 subprocess 在远端 cwd 下 verbatim 运行。`agent/session-start` 把该会话的沙箱覆盖设为 `danger-full-access`，因为远端 OS 用户即边界。overlay 必须禁用 stock 的 `fs-sandbox`、`subprocess`、`bash-sandbox` 与 `pwsh-sandbox` 行；否则 `remote-host` 在加载时失败，而不会提供无路由的卡片。subprocess 为缓冲式执行（`localExec`）；v1 不支持管道 stdin 与 PTY。不发布 `./invariant`：网关可达性是实时探测，不是独立观察会分叉的已存关系。

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [可移植执行世界](../../../.agents/notes/implemented/architecture/2026-07-28-portable-execution-world-consumers.zh.md) — 为何 fs 与 subprocess 必须一起移动。

-----

<a id="model-experience"></a>
## Model Experience

None, as the package routes existing file and shell tools without registering a model-facing tool or prompt.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **无需 ssh/Python 环境** — 对方是 DSH 网关，两端都不需要 ssh 二进制、Python 助手或 ControlMaster 状态。
- **发现信任所在网络** — 局域网或 tailnet 上的实例都可广播并被登记；在你从它身上登记项目之前，注册表条目本身无害。`discovery.enabled: false` 可只用手动主机。
- **缓冲式执行** — `localExec` 缓冲 stdout/stderr；v1 不支持管道 stdin 与 PTY。
- **无远程 PTY** — 远程会话上 `spawnTerminal` 会拒绝。
- **无远程内核沙箱** — 远程会话使用 `danger-full-access`；远程 OS 用户即边界。
- **仅源码 checkout** — 正式发行载荷不含此私有包。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

None.

</details>
