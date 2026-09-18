# Remote DSH readiness

- [x] Can Start: the existing DSH Web process responds at `http://127.0.0.1:3080/` with HTTP 401 for an unauthenticated request. No replacement server is required.
- [x] Can Test: `pnpm exec vitest run packages/client/connection/tests/api-helpers.client.spec.ts` passes two tests. Package-manager bootstrap required approved access outside the workspace.
- [x] Can See Progress: [feature list](features.md) records this workstream.
- [x] Can Pick Up Next Steps: F2.1 (saved profiles and session operations) is the active milestone after the authenticated read-only round trip.

The working tree contains unrelated staged and unstaged edits. Preserve them and scope every change to this feature; do not create a repository-wide checkpoint commit.
