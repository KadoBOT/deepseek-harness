# Agent Note: Browser RPC survives insecure LAN origins

Status: implemented

English | [中文](2026-08-23-web-lan-insecure-context-rpc.zh.md)

## Problem

The [all-interfaces web serving](../feature/2026-08-23-web-all-interfaces-cli.md) decision exposed a latent carrier defect: a page loaded over plain HTTP from a non-loopback address is an **insecure context**, and browsers gate `crypto.randomUUID` behind secure contexts — loopback origins are always secure, so every loopback session hid the bug. `AbstractApiClient.mintRpcId()` called it directly, so over a LAN IP every unary RPC threw before the request was written, `ConnectionController` aborted each generation's two connecting downlink sockets (surfacing as 1006 closes and endless reconnect warnings), and the GUI loaded no data at all. The draft-attachment id mint in ui-conversation had the same dependency for image attachments.

## Decision

The fetch carrier mints ids through a helper that uses `crypto.randomUUID` when present and otherwise derives an RFC 4122 version 4 UUID from `crypto.getRandomValues`, which browsers expose on insecure origins; the helper stays module-private to the apiproxy client. ui-conversation carries the same package-private mint for draft attachment ids rather than widening any plugin's public export face, per client export discipline. Loopback-gated privileged methods (credential management) are unchanged and remain unreachable from non-loopback pages by design.

## Alternatives considered

**Require HTTPS or a reverse proxy for LAN access.** Rejected because the shipped all-interfaces mode promises plain-HTTP LAN use on a trusted network; TLS termination is an operator deployment choice, not a carrier precondition.

**Export the existing connection-package UUID helper and import it everywhere.** Rejected because cross-package value imports between client plugins are forbidden by export discipline, and widening the connection `./client` entrypoint for one helper would trade a boundary rule for convenience.

**Gate LAN serving behind the fix or revert the bind flag.** Rejected because the defect is in the carrier's platform assumption, not in the binding decision; loopback serving merely masked it.

## Consequences

Every browser bundle now works on both secure and insecure origins with one code path per mint site; Node callers keep taking the native `randomUUID` branch. The regression test deletes `crypto.randomUUID` and asserts unary calls still mint valid version 4 ids. Any future browser code that reaches for `crypto.randomUUID`, `crypto.subtle`, or other secure-context-only APIs re-introduces this class of loopback-only failure and needs the same fallback treatment.
