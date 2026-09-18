# Agent Note: Direct-apply delegation enforces the default depth budget

Status: implemented

English | [中文](2026-09-14-subagent-direct-apply-depth-default.zh.md)

## Problem

`dsh-tool-subagent` declares its `maxDepth` default (`3`) in the Schemastery Config schema, which only the Loader path applies. A direct `apply()` call bypasses Schemastery, so an omitted `maxDepth` resolved to no cap at all: the start request carried no budget, and a provider without the `depthLimit` capability mounted silently instead of failing loud. Two entries into the same plugin therefore enforced two different recursion budgets, and the quieter entry was the unbounded one.

## Decision

`packages/subagent/tool-subagent/src/index.ts` exports `DEFAULT_MAX_DEPTH` as the single source of truth, uses it for the schema default, and resolves a direct-apply omission to it in `apply()`. The mount-time capability check and the start-request budget both consume the resolved value; only an explicit `maxDepth: 'provider-managed'` sends no cap, as documented for out-of-process providers. This aligns with the depth-budget decision in [child delegation depth](../feature/2026-07-12-subagent-persona-tool-filter-and-depth.md), which this note leaves in place.

## Alternatives considered

**Keep the direct-apply omission capless.** Rejected because two entries into one plugin enforced different budgets, and the silent entry was the unbounded one; a recursion cap that depends on which caller mounted the plugin is not a cap.

**Duplicate the literal `3` in the fallback.** Rejected because the schema default and the fallback would drift independently; one exported constant keeps them identical by construction.

**Reject direct `apply()` without Schemastery.** Rejected because hand-built compositions and package tests legitimately bypass the Loader, following the same pattern the ACP agent backend uses for its defaults.

## Consequences

- Every `tool-subagent` instance enforces a numeric depth budget unless its deployment explicitly opts out with `'provider-managed'`.
- A direct-apply mount against a provider without `depthLimit` now fails loud instead of running unbounded; six existing tests that exercise background and preflight mechanics over capability-less providers declare the opt-out explicitly.
- No model-visible text changed, so no snapshot re-record was required.

## Testing

`packages/subagent/tool-subagent/tests/tool-subagent.spec.ts` pins the new behavior: a direct-apply omission forwards `maxDepth: 3` in the start request, and a direct-apply omission against a provider without `depthLimit` rejects at mount. The full package suite (155 tests), `tsc --noEmit`, `oxlint`, and the keyless subagent snapshot replay all pass.

## Deferred

- Task-sizing guidance in the delegation tool descriptions (one child, one verifiable deliverable; split multi-phase work; state expected output size). The text touches dozens of snapshot files and needs a keyed re-record, which was unavailable; it belongs in descriptions, which parent and fork child share identically under the [fork prefix-reuse decision](../architecture/2026-08-10-fork-children-stay-one-shot.md), not in new sections.
- A delegation deadline that bounds detached background and continuable children. `ToolDefinition.timeoutMs` only bounds one synchronous tool call, so enforcement belongs on the job controller and the continuation manager, not the tool definition.
- A loop-level turn budget. A plugin-level pre-step rejection surfaces as `refusal`, so a distinct stop reason needs a `TurnEndReasonMap` change in `agent-loop` plus its architecture-docs update.
- A child-to-parent progress signal between `started` and `settled`. No such channel exists today, and its absence is the more plausible driver of oversized assignments than sizing prose alone.
