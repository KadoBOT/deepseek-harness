---
description: "Experimental DSH-to-DSH machine registry and execution-world router so one dsh web process can open projects that live on another DSH on the same machine or Tailscale LAN."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-remote-host

English | [中文](README.zh.md)

## Summary

`dsh-experimental-remote-host` lets a primary `dsh web` process talk to a secondary `dsh web` on the same machine or the same Tailscale LAN: you register the secondary by URL, browse a directory there, and adopt it as a Workspace labeled with that machine. Sessions opened from those Workspaces run file and shell tools on the secondary through host-plane fs/subprocess/shell routers. No ssh binary, Python helper, or ControlMaster state is involved. Official releases exclude this package.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

From this checkout, overlay the source patch (private packages stay in the tree; they are not installed into the profile):

```sh
pnpm dsh web --patch ./packages/experimental/remote-host-web-profile/source.cordis.patch.yml
```

Each host is a secondary `dsh web` base URL: `http://127.0.0.1:3081` for same-machine dev or `http://gpu.tailnet.ts.net:3080` on the Tailscale LAN. Start the secondary with `dsh --profile web --host 0.0.0.0 --port 3080 --no-open` (defaults already trust Tailscale peers; no token needed). After a host is saved, **Add remote project** in the sidebar foot picks a machine and a directory; the Workspace appears in the sidebar with that machine's label beside the title.

Run the same overlay on both machines and they find each other on their own: every instance beacons its URLs over the LAN (UDP multicast) and the tailnet (unicast to `tailscale status` peers), vets beacons with a gateway call, and registers reachable peers automatically. Nothing to paste. Discovery is on by default and stays inside the plugin:

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
<summary>Implementation internals — click to expand</summary>

The package mounts `ctx.remoteHosts` plus routers that occupy `ctx.fs`, `ctx.subprocess`, and `ctx.shell`. Local sessions keep the isolated local backends, constructed on isolated Cordis scopes so they do not collide with the routers. A session whose header carries `machineId` is routed to the secondary DSH gateway: files through `remoteHosts/local*` remotes, shell commands as `bash -c` through the routed subprocess with the remote cwd verbatim. `agent/session-start` sets that session's sandbox override to `danger-full-access` because the remote OS user is the confinement boundary. The overlay must disable the stock `fs-sandbox`, `subprocess`, `bash-sandbox`, and `pwsh-sandbox` rows; otherwise `remote-host` fails at load instead of serving an unrouted card. Subprocess streaming is buffered (`localExec`); piped stdin and PTY stay unsupported in v1. No `./invariant` export: gateway reachability is a live probe, not a stored relation independent observations can diverge on.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Portable execution worlds](../../../.agents/notes/implemented/architecture/2026-07-28-portable-execution-world-consumers.md) — why fs and subprocess move together.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package routes existing file and shell tools without registering a model-facing tool or prompt.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **No ssh/Python env** — the secondary is a DSH gateway, so no ssh binary, Python helper, or ControlMaster state is needed on either side.
- **Discovery trusts the network** — any instance on the LAN or tailnet can announce itself and be registered; registry entries are inert until you adopt a project from them. Set `discovery.enabled: false` for manual-only hosts.
- **Buffered exec** — `localExec` buffers stdout/stderr; piped stdin and PTY stay unsupported in v1.
- **No remote PTY** — `spawnTerminal` rejects on a remote session.
- **No remote kernel sandbox** — remote sessions use `danger-full-access`; the remote OS user is the boundary.
- **Source-checkout only** — official release payloads exclude this private package.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
