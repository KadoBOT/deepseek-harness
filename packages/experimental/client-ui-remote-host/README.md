---
description: "Web UI to register SSH/Tailscale machines and add their projects from the sidebar."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-client-ui-remote-host

English | [中文](README.zh.md)

## Summary

`dsh-experimental-client-ui-remote-host` is the browser half of remote workspaces: a Plugins settings card to add SSH or Tailscale hosts, and a sidebar footer action that adopts a directory on a chosen machine. Official releases exclude this package.

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

Mount it with [`remote-host-web-profile`](../remote-host-web-profile/README.md). The sidebar foot gains **Add remote project**; Settings → Plugins shows **Remote hosts**.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin registers into `settings.plugin.item` keyed `remote-hosts` and into `sidebar.footer.action`. It calls `ctx.remote.remoteHosts` and does not shadow the workspace browser; machine labels on project rows come from WorkspaceView.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [remote-host](../remote-host/README.md) — Host registry and SSH execution router.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side UI plugin layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Directory listing, not a Miller picker** — the add flow lists remote directories over SSH; it is not the stock local folder dialog.
- **Source-checkout only** — official release payloads exclude this private package.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
