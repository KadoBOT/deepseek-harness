---
description: "Sidebar browsing region variant: active sessions unified above the workspace groups with recency sorting and shadowing priority."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-active-sessions

English | [中文](README.zh.md)

## Summary

`dsh-client-ui-active-sessions` is an active-first sidebar browsing region variant for the dsh web client: it hoists running, user-awaiting, and unviewed-completed sessions across all workspaces into a single unified top section sorted strictly by recency. It shadows the standard `sidebar.workspaces` slot at priority `-1` without losing the underlying default registration or its directory-flow picker hole. Below the active section, workspaces display collapsible recency-ordered group sections with quick-add actions.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Sidebar browsing region variant that hoists active sessions above the workspace groups ([Agent Note](../../../.agents/notes/implemented/architecture/2026-08-26-ui-active-sessions-shadow-sidebar-cell.md)). The package registers `ActiveSessionsBrowser` into the sidebar shell's `sidebar.workspaces` slot at shadowing priority `-1`: the slot system renders a single-kind cell's lowest live entry, so this component wins the cell while ui-workspace's stock browser registration (default priority `0`) stays mounted underneath. Removing this package's composition row — or disposing its entry at runtime — hands the seat straight back to the stock browser with no reload. Because the shadowed browser keeps its directory-flow declaration while mounted, this package declares no child slots of its own.

The **Active** section is one unified list across all workspaces containing every visible session whose summary reports live running state, a pending user interaction (approval, plan review, or question), or an unviewed-completion reminder; rows sort strictly by last activity, newest first, each tagged with its owning workspace title (falling back to the cwd basename for strays). Opening a row routes through the injected face to `ctx.sessions.open`, which also clears that session's completion reminder through the runtime's normal selection path. Active rows are never duplicated in the sections below. Visibility mirrors the shipped rules: subagent-origin rows surface only through their parent's catalog, archived rows hide everywhere, and blank sessions stay hidden unless they are the provisional current one, whose localized **New Session** placeholder keeps its workspace group visible.

Below the Active section, every workspace renders as a collapsible group header (title plus remaining-row count) whose member rows again order by last activity rather than the Host's manual account order — the deliberate difference from the stock browser's Manual mode. Hovering a header swaps its count for a New Session plus that connects a blank session in that workspace and opens it (which also selects the workspace); a collapsed group expands first so the new row is visible. The Ungrouped bucket has no workspace to target and keeps its plain count. Groups whose remaining rows are empty stay hidden unless they hold the current session, so hoisting cannot leave an empty group behind. Group folding is component-local state and defaults to expanded. In the collapsed rail the region renders one search affordance that expands the sidebar plus a badge counting active sessions.

A non-blank search query replaces the body with one flat result list built immediately from case-insensitive title and workspace-substring matches over the list data, while the ranked current-conversation content request waits out a 250 ms keystroke debounce. Content hits merge under the local segment with snippets folded into matching rows, invisible classes stay excluded, and the merged list caps at `searchResultLimit`. Selecting a result opens its session and clears the query. Each new query aborts the preceding request; a failed or superseded search leaves the previous page visible. Row status dots reuse the shared `StateDot` primitive states: amber for waiting on the user, blue chase for running, green for the completion reminder.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Both target slots are declared by other plugins, so `apply` uses `slots.inject()` to register for the declaration lifetime. Copy lives in the `activeSessions` locale namespace (zh/en dictionaries registered at apply).

</details>

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a browser-side UI plugin layer that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Shadowing trades away stock browser affordances while this entry wins the cell** — the sidebar header has no Add-workspace shortcut (the new-session hero picker still adds workspaces), and row context menus (rename, fork, archive, reorder drags) are absent.
- **Ordering is always Last-updated** — the stock browser's persisted Manual drag-order preference is neither honored nor editable here; no drag surfaces exist in this variant.
- **Running-descendant lineage is not aggregated** — unlike the stock browser, a row lights only its own status dot while descendant subagent sessions run; their activity is visible in the parent conversation's subagent catalog.
- **Group folding does not survive remounts** — expanded/collapsed state is component-local by design and resets when the region remounts.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
