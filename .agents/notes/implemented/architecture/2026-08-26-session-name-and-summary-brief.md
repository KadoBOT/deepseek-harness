# Agent Note: Session naming — the model writes a name plus a summary, not a prompt prefix

Status: implemented

English | [中文](2026-08-26-session-name-and-summary-brief.zh.md)

## Problem

Session names came from the deterministic fallback: the first words of the user's prompt. The fallback exists so a name is never missing, but as a *product* name it fails twice — it echoes phrasing rather than describing intent ("Reply with exactly TITLE_DONE. Do" names nothing), and the sidebar had no way to show what the session is about without opening it.

The model-backed provider path already existed, but in practice almost every deployment lost to the fallback: the auxiliary call was budgeted `maxOutputTokens: 64` and routed through reasoning-capable routes (the deployed default emits reasoning blocks). The trace alone exhausted the cap, every call ended `max-tokens`, and the service kept the fallback. The feature was present, configured, and dead.

## Decision

**The model produces one JSON object with two fields — `name` and `summary` — on a single line.** One auxiliary call answers both product needs: the sidebar title stops echoing the prompt, and the hover card can show a one-sentence description of intent instead of the clipped prompt. The shared helper (`session-title-llm`) owns this as the *brief* variant: same route resolution, framing, request record, deadline composition, and stream assembly as titles; different instruction, output parsing, and acceptance. `generateSessionBriefWithLlm()` parses the JSON leniently (fenced output and surrounding reasoning text are ignored by slicing the outermost braces), normalizes both fields, truncates the summary to `maxSummaryBytes` on code-point boundaries, and appends a log-only `session/summary` event before returning; the title service then appends the provider title, so a log always shows the summary immediately before the title that was derived with it.

**The summary rides the projection system, not a new wire path.** `session/title/src/types.ts` declares the `summary` key in both projection merges next to `title`; the brief registrar registers the unit (string-or-null state, identity wire view), and the client tree copies `projectionValues.summary` onto the row node for the hover card. No session-list RPC changes, no new client service, no per-client fetching.

**Reasoning traces get their own config line, and the shipped defaults assume they exist.** `maxOutputTokens` is documented as the budget for reasoning trace plus visible answer, and the base bundle row now ships 1024 with an explicit comment. Sizing it "just over a title length" silently disables the whole feature on reasoning routes; sizing it generously costs nothing when thinking is disabled, which is the DeepSeek adapter's behavior for this purpose.

## Alternatives considered

- **Two calls (title, then summary)** — doubles auxiliary latency and cost for one turn of the same conversation, and lets the two answers disagree.
- **Deriving the summary from the title locally** — a five-word name cannot be expanded back into intent without inventing content the model never produced.
- **A separate provider plugin owning summaries** — the title service's single-provider seat would force deployments to choose between features that share one trigger, one cadence, and one route decision.
- **Structured-output adapters instead of JSON-in-text** — the helper runs against arbitrary adapters through `ctx.llm.stream()`; text-only JSON keeps the contract adapter-neutral, and fenced/reasoning-wrapped answers are already tolerated by parsing.
## Consequences

The first-prompt provider now asks for and persists two values; its config grows three required fields (`targetSummaryWords`, `targetSummaryCjkCharacters`, `maxSummaryBytes`), so existing compositions must add them or fail loud at load. Deployments that already set explicit `provider`/`model` overrides keep working unchanged; deployments relying on route inheritance need the larger token cap only if their route reasons. Sessions titled before this change keep their fallback titles until an explicit refresh or a later all-prompts revision; the running GUI picks up the hover rendering only after rebuilding the web bundle and restarting the server. A malformed JSON answer rejects the whole revision — no partial acceptance of a bare name — because the summary is the point of the variant, and the failure path is identical to any other provider rejection (fallback retained, warning logged).
