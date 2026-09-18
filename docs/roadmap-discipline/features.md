# Remote DSH feature list

This ledger covers the approved installed Remote DSH connector, not unrelated work in this checkout.

## Phase 0: Initialization

### F0.1 — Environment and test readiness

- State: complete
- Implementation: existing Web server responds; package-manager and Vitest execution are available.
- Verification: HTTP 401 from the existing GUI root; two existing connection helper tests pass. See [readiness](readiness-checklist.md).

## Phase 1: Authenticated connection

### F1.1 — Read-only round trip

- State: complete
- Implementation: a local Host connector exchanges the remote's launch token for its authority-bound cookie and reads provider metadata over the authenticated HTTP API, with timeouts, byte limits, no redirect following, and caller-owned disposal.
- Verification: `pnpm exec vitest run packages/api/remote-connector` passes four tests: option validation, no-redirect on an expired token, oversized-response rejection, and the real-composition authenticated round trip (401 without a cookie, success after the exchange). See [readiness](readiness-checklist.md).

## Phase 2: Remote controls

### F2.1 — Saved profiles and session operations

- State: active
- Implementation: save names and URLs separately from credentials; browse remote workspaces and sessions; create sessions, send prompts, follow output, and interrupt turns without automatic mutation retries.
- Verification: two-instance integration coverage for target isolation, disconnects, permissions, and explicit approvals.
- Progress: the profile store lands under `packages/api/remote-connector/src/profiles.ts` with three passing behavior tests (token kept out of the profile file, validation rejections, removal). Session listing rides the connector's scripted-gateway envelope test; a real-composition `session/list` case still needs the base session stack and is deferred until the connector is wired into a full profile.

### F2.2 — Remotes GUI

- State: not_started
- Implementation: expose labeled remote controls and explicit approval actions through an installed UI plugin.
- Verification: localized UI tests and assembled browser evidence at the existing GUI URL after rebuilding and refresh.
