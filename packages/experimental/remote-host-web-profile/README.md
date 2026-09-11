---
description: "Add experimental SSH remote workspaces to a source-checkout Web profile."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-remote-host-web-profile

English | [中文](README.zh.md)

## Summary

`dsh-experimental-remote-host-web-profile` is the private Web layer for remote SSH/Tailscale workspaces. Add it after `dsh-web-app` so the Host mounts the SSH router and the browser shows machine-labeled projects. Official releases exclude this package.

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

From this repository checkout, overlay the source patch so the private packages do not need to be installed into the profile:

```sh
pnpm dsh web --patch ./packages/experimental/remote-host-web-profile/source.cordis.patch.yml
```

`dsh plugin --profile web add ./packages/experimental/remote-host-web-profile` is the durable install path; it runs `pnpm add` in `$DSH_HOME/profiles/web` and fails if that profile already depends on an unpublished registry package. Settings → Plugins lists Remote hosts; the sidebar foot gains Add remote project. Same-named folders on different machines show distinct machine labels.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The patch replaces the `fs-sandbox` row with `@deepseek-ai/dsh-experimental-remote-host`, disables the `subprocess` row so a second `ctx.subprocess` cannot register, and inserts the Client UI. The router still constructs sandboxed local backends on isolated scopes for sessions without `machineId`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [remote-host](../remote-host/README.md)

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a profile bundle that mounts remote-host plugins and registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Replaces local fs/subprocess rows** — the bundle disables the stock local providers and relies on the router to re-instantiate them for local sessions.
- **Source-checkout only** — official release payloads exclude this private package.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
