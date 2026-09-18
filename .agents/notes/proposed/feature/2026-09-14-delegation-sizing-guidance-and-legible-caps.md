# Agent Note: Sizing guidance and legible caps for delegation tools

Status: proposed

English | [中文](2026-09-14-delegation-sizing-guidance-and-legible-caps.zh.md)

## Problem

Delegation tools describe how to delegate but never how much. The `subagent` descriptions in `providerWording()` (`packages/subagent/tool-subagent/src/index.ts`) say what a child is, not what fits in one child; the `workflow` description (`packages/workflow/tool-workflow/src/index.ts`) names its hooks exactly but reports its caps as the unnamed phrase "concurrency and total-agent caps apply", so the model learns the real numbers (concurrency `min(16, cores-2)`, 1000 agents per run, 4096 items per call, 50 000 result characters) only from an error string after tripping one. The depth-default fix in [direct-apply depth budget](../../implemented/bug-fix/2026-09-14-subagent-direct-apply-depth-default.md) closed a budget hole; the sizing decision itself is still unguided, and that round had no API key for the snapshot re-record this change requires.

## Proposal

Put the sizing contract in tool descriptions, which reach every instance symmetrically: parent and fork child share identical tool descriptions under the joined preset, including one-shot fork and out-of-process backends that never get a prompt section.

Append this sentence to both `providerWording()` descriptions (fresh and fork), ahead of the background suffix:

```text
Scope each delegation to one verifiable deliverable the child can finish and report back; split multi-phase work into one delegation per phase, and do the work inline when it needs at most a couple of tool calls.
```

Append this sentence to both `promptDescription` strings:

```text
State the expected shape and size of the result.
```

Render the workflow limits from configuration instead of naming no numbers. `tool-workflow` owns `maxResultChars`; the engine owns concurrency, total, and per-call item caps, so the workflow service seam gains a `limits()` accessor the worker-thread engine implements, and the description templates the resolved values:

```text
Constraints: at most {concurrency} agents run at once, {total} agents per run, {items} items per agent() call, and {chars} result characters; no filesystem, network, timers, or Node.js APIs are provided — the agents do the work, the script only coordinates them. The run executes in the foreground: this call returns when the whole script finishes.
```

When no engine is mounted at registration, keep the current generic sentence as the fallback. Unit tests pin the sizing sentence verbatim in both wordings and assert configured numbers appear in the workflow description; the snapshot corpus is re-recorded with a key and replayed keyless.

## Alternatives considered

**A new prompt section for sizing.** Rejected because section registration is gated on background-plus-continuable, so one-shot fork and out-of-process tools would still get nothing; description text is the only channel every instance already carries.

**Hardcoded literals in the description.** Rejected because deployment-varying values must be validated Config fields; literals would drift from engine configuration.

**Shape-only wording without numbers.** Kept as the engine-absent fallback, rejected as the steady state: bounds the model cannot see are bounds it cannot plan within.

**Sizing guidance in the deployment persona.** Rejected by convention: tool guidance lives in tool plugins as prompt sections and descriptions, not in the deployment persona.

## Acceptance criteria

- Both `subagent` wordings in every background mode contain the sizing sentence; the package spec asserts it verbatim.
- The `workflow` description renders the configured numbers, including non-default Config values; the engine-absent fallback is covered.
- The snapshot corpus is re-recorded with an API key; the full keyless `test:snapshot` run and `test:docs` are green.
- The description length delta is measured and recorded in the change.

## Risks

- Prose compliance is unmeasurable: snapshots pin the guidance text, never whether the model obeys it; the legible caps are the enforceable half of this change.
- The longer descriptions invalidate cached request prefixes once at deploy; the prefix is stable afterwards.
- Rendered limits can stale if engine configuration changes after tool registration; re-resolution on engine change is open.
