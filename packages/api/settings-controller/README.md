---
description: "Host Remote owner for settings, credential configuration, and browser authorization surfaces."
kind: "package-reference"
---
# Settings Controller

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-api-settings-controller` exposes generated `ctx.remote.settings`, `ctx.remote.credentials`, and `ctx.remote.authorization` namespaces for browser configuration surfaces. It returns redacted settings, credential metadata, and browser authorization progress, supports settings and credential writes without returning secret values, and opens provider-owned settings or Agent preset locations on the Host desktop. When a provider is absent, the namespace remains registered and returns an actionable configuration error.

## Table of Contents

- [Use this package](#use-this-package)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package as a Loader entry in a profile that serves browser configuration. The entry registers all three namespaces independently of their providers so a missing provider produces a named configuration error at invocation. Its generated descriptors enter the strict Typert registry, while the settings, credential, and authorization Definitions remain plain Cordis Services with no wire obligations of their own.

`describe(refs)` answers one map keyed by the requested names, so a settings page describing every reference its rows carry settles those rows together. It accepts at most 64 names per call, reports an invalid name or empty write value as `bad-request`, and copies each answer field by field — a provider returning more than `CredentialInfo` declares cannot widen what crosses. Valid `set(ref, value)` and `unset(ref)` calls report a provider refusal as `credential-rejected`, carrying the provider's message with only the reference in its details. Secret values cross in this direction only: no method here returns one.

`settings.describe()` returns deployment facts and every namespace under `redactSecrets: true`. `settings.update`, `settings.replace`, and `settings.mutate` expose the settings service's three write operations and return the namespace's new redacted view; stale writes use `settings-conflict` and other provider refusals use `settings-rejected`.

`settings.openSettingsDocument()` prepares the provider-owned document and opens it with the native text-editor intent. `settings.canOpenAgentPresetDirectory()` reports native-opening availability when the preset page becomes visible. `settings.openAgentPresetDirectory(id)` resolves only a user-authored preset and either opens its directory or returns the path when native opening is unavailable; neither open method accepts a browser-supplied filesystem target.

`authorization.list()` lists registered flows and redacted credential metadata. `authorization.begin()` starts one flow and returns an opaque attempt id; the browser polls `read()`, answers the current prompt with `respond()`, and can `cancel()` or `disconnect()` it. One latest attempt is retained per flow, prompt answers are consumed immediately, and authorization timeout is controlled by `authTimeoutMs`.

-----

<a id="configuration"></a>
## Configuration

| Field | Default | Meaning |
|---|---|---|
| `nativeOpen` | platform-detected | Whether Agent preset directories can be handed to a native desktop opener |
| `authTimeoutMs` | 10 minutes | Maximum time one browser authorization flow may run |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-api-settings-controller) is the exhaustive source for accepted fields and their JSDoc.

-----

<a id="model-experience"></a>
## Model Experience

None, as settings and credential configuration are browser and Host state and register no prompt, tool, or session event.

#### KV Cache effect

No direct effect; reading or writing these configuration values does not alter model requests already in flight.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The batch bound is fixed at 64 references and is not a deployment-configurable field.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The settings and credential seams own storage and update events, while this package only projects their methods onto the wire.
