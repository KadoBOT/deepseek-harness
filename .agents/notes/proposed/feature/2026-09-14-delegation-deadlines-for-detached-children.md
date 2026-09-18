# Agent Note: Delegation deadlines for detached children

Status: proposed

English | [中文](2026-09-14-delegation-deadlines-for-detached-children.zh.md)

## Problem

Detached children have no wall clock. A foreground delegation returns with the call, but a one-shot background job resolves at spawn and a continuable child resolves at inbox acceptance (`packages/subagent/tool-subagent/src/index.ts:529-563`); from there the child runs until it stops on its own or an ancestor interrupts it. `ToolDefinition.timeoutMs` cannot reach these paths: it bounds one synchronous `tools/execute` span, while the one-shot background path builds its own `AbortController` decoupled from `exec.signal` (`:552`) and the continuable path detaches at acceptance (`:530-539`). Interrupt authority admits only `user` and `ancestor` (`packages/subagent/subagent/src/continuation.ts:125-127, 730-762`); no manager or system actor exists. The settlement vocabulary already distinguishes outcomes by diagnostic presence — `aborted` without one settles `killed`, with one settles `failed` (`packages/subagent/subagent/src/run-settlement.ts:37-53) — but no shipped provider maps `signal.reason` to a diagnostic, so a bare abort is indistinguishable from a user kill.

## Proposal

Enforce deadlines at the layer that owns each detached path, reusing the killed-versus-failed distinction instead of adding a stop-reason variant.

Add an optional `deadlineMs` validated Config field on `tool-subagent` (natural milliseconds; absent preserves today's unbounded behavior). `ToolDefinition.timeoutMs` stays unused: it yields a `TOOL_TIMEOUT` error with no partial result and misses detached paths by construction.

For one-shot background jobs and foreground calls, the tool arms its own timer on the job/run controller. On expiry it aborts with a deadline reason, and the settlement wrapper converts a deadline-fired outcome to `failed` with the detail `delegation deadline exceeded after {N}ms: {label}; split the task and delegate per phase instead of retrying unchanged`. The timer is fiber-owned and cleared on settle, cancel, and dispose, so no handle outlives its job. User cancellation still settles `killed` with no diagnostic, keeping the two outcomes distinguishable through the existing settlement mapping.

For continuable children, `deadlineMs` travels through `startContinuable` (validated at the boundary, never durable — the descriptor version is untouched) and the continuation manager arms the timer at inbox acceptance. On expiry it cancels the live turn directly with a parent cause — no new public authority variant, no authorization surface change — and marks the Activation, so the settlement notice distinguishes a deadline interrupt from a natural end. A parent delivery disarms the timer and resets the marker: re-engagement is a fresh mandate, so the deadline only ever bounds the initial unattended run, which is the window an oversized fire-and-forget delegation actually endangers.

The deadline detail instructs split-don't-retry, closing the double-burn loop where a parent retries the same oversized task; the wording references the sizing guidance in [sizing guidance and legible caps](2026-09-14-delegation-sizing-guidance-and-legible-caps.md).

## Alternatives considered

**Declare `ToolDefinition.timeoutMs` from Config.** Rejected because the timeout-policy guard reports `TOOL_TIMEOUT` with no partial result, and because it structurally cannot touch the detached background and continuable paths that motivated this change.

**Add a `deadline` stop-reason variant.** Rejected for one-shot runs: diagnostic presence already separates user kills (`killed`) from deadline expiries (`failed`), and the stop-reason map stays smaller; the continuable marker lives on the Activation and settlement notice instead.

**Capability-gate the deadline like `depthLimit`.** Rejected because every provider already honors the abort signal; no provider would reject the capability, so gating adds ceremony without a rejector.

**Hard-kill the child on expiry.** Rejected because no such mechanism exists: cancellation is cooperative by architecture, and providers that ignore the signal keep running, exactly as the timeout-policy guard documents.

## Acceptance criteria

- A hanging-provider fixture with a deadline settles `failed` carrying the deadline detail; the same fixture killed via `job_kill` still settles `killed` with no diagnostic.
- A foreground deadline returns an error result with the deadline detail and preserves the child's partial assistant text.
- A continuable deadline cancels the live turn directly with a parent cause and the settlement notice carries the marker; a re-engaging parent delivery disarms it; deadline-absent behavior is unchanged.
- Config rejects non-natural `deadlineMs` values at load.
- The default-absent deadline changes no model-visible text, so existing snapshots replay unchanged.

## Risks

- Enforcement stays cooperative: a provider that ignores the abort signal keeps running past expiry; the settlement marking, not termination, is the guaranteed half.
- A deadline can cut legitimately long work: expiry is opt-in per instance, deployments tune the value, and the detail tells the parent what happened.
- Timer lifecycle must clear on every path (settle, cancel, dispose); a leaked handle outlives its job, so disposal coverage is load-bearing.
- Wall-clock milliseconds count laptop sleep and suspension; deployments with bursty scheduling should size accordingly.
