# Agent Note: Trusted-network browser access without launch tokens

Status: implemented

English | [中文](2026-09-03-trusted-network-browser-authentication.zh.md)

## Problem

[`dsh web --host 0.0.0.0`](../feature/2026-08-23-web-all-interfaces-cli.md) binds every IPv4 interface and adds sampled interface addresses to the browser-trust Host allowlist, but [browser-session authentication](2026-08-24-browser-token-authentication.md) still requires a launch-token exchange and authority-bound cookie for index HTML, HTTP API calls, and WebSocket upgrades. Calling this mode unauthenticated hid the separate binding and authentication choices, while a direct Tailscale-IP request reached the server and stopped at 401.

A Tailscale MagicDNS name reaches the same socket but is not one of the sampled IP-literal authorities. Its index request could exchange a token because ordinary index authentication does not apply the Host fence, then the page's HTTP API and `/api/remote.mux` WebSocket requests failed that fence with 403. The result looked like a transport failure after a successful page login rather than a missing `--trusted-host` declaration.

The operator needs an explicit mode in which peers on directly attached private LANs or the Tailscale network can use the Web application without copying a process token. Loopback use must retain the existing token flow, and the mode must not turn every peer that can route to an all-interface socket into an authenticated caller.

## Decision

`dsh web` accepts `--allow-unauthenticated-network` only together with an explicit `--host 0.0.0.0`; any other combination exits with a usage error before the Web rows activate. Startup fails with a correction-oriented error when the flag is set but no eligible interface rule can be derived.

`dsh-web-app` samples `node:os.networkInterfaces()` once after the server binds and produces source-and-destination rules separately from `trustedHosts`. An RFC 1918 IPv4 interface contributes its local address paired with that interface's subnet only when the prefix keeps the subnet inside its RFC 1918 block. A local address in Tailscale's `100.64.0.0/10` range contributes that local address paired with the complete Tailscale IPv4 range. Public, link-local, loopback, malformed, and IPv6 entries contribute no unauthenticated rule; the current Web carrier binds IPv4 only. The existing list of non-internal IPv4 literals remains the Host allowlist and URL-display input.

Connection matches a rule against the actual socket's normalized `localAddress` and `remoteAddress`, including IPv4-mapped IPv6 forms. A request bypasses browser-session authentication only when both addresses match one rule. Missing socket facts, an unmatched destination, an off-subnet source, and loopback all continue through the launch-token and cookie flow. Connection never reads `Forwarded`, `X-Forwarded-For`, or another proxy assertion.

The Host/Origin/cross-site browser-trust fence remains mandatory before any network bypass. `/api` HTTP requests and `/api/remote.mux` WebSocket upgrades use the same rejection decision. A clean index request from a matching network peer passes the same fence before the frontend is served; a token query on such a request redirects to a clean URL without retaining the process token. A MagicDNS authority therefore requires an explicit Host declaration even when its peer is trusted:

```sh
dsh web --host 0.0.0.0 --allow-unauthenticated-network \
  --trusted-host olares-1.hake-skink.ts.net
```

The startup line keeps the loopback URL tokenized because loopback remains authenticated. It prints a clean `LAN/Tailscale` URL for the first derived rule and states that only detected LAN and Tailscale peers bypass authentication. Without the flag, every printed URL remains tokenized and the warning describes authenticated all-interface serving.

This decision partially supersedes browser-session authentication's uniform-cookie rule and its rejection of TCP peer addresses as identity. The token remains the identity for loopback, unmatched peers, proxy-delivered loopback traffic, and all-interface launches without the flag. Host and Origin remain routing evidence and confused-deputy defenses rather than identity.

## Verification

Connection unit tests pin rule validation, plain and IPv4-mapped address normalization, destination-plus-source matching, loopback rejection, clean index redirects, and Host-fence ordering. Real HTTP and WebSocket host tests bind an all-interface server and prove a matching peer succeeds without a cookie while loopback remains 401 and an untrusted Host remains 403. Web bundle tests pin CLI validation, interface classification, safe subnet derivation, runtime wiring, clean network output, and tokenized loopback handoff. The built `dsh` CLI test connects through the printed non-loopback address and proves index and API access without weakening loopback or Host rejection.

## Alternatives considered

**Require explicit source CIDRs.** A repeatable `--allow-unauthenticated-from <cidr>` option is precise and supports unusual routed networks, but it makes the common private-LAN and Tailscale case depend on manual address calculations. The shipped flag deliberately supports only ranges that startup can derive from directly attached interfaces.

**Bypass authentication for every all-interface request.** Binding and authentication are independent choices. Treating `--host 0.0.0.0` as identity would grant every routed peer the operating-system user's tool authority and would make the explicit security flag meaningless.

**Treat `trustedHosts` as authenticated identities.** `Host` is supplied by the client and proves neither socket source nor Tailscale membership. Reusing it for authentication would let a non-browser caller spoof an allowed authority and would collapse the existing DNS-rebinding fence into an identity check it was not designed to provide.

**Discover and trust MagicDNS automatically.** Calling the Tailscale CLI or resolving a mutable DNS name would add an optional external dependency and a second discovery lifecycle. The existing `--trusted-host` option states the authority explicitly, while the new flag addresses peer authentication only.

## Consequences

Every peer admitted by a derived rule receives the complete tool-capable Host authority. Socket addresses are routing facts rather than cryptographic identities, and plain HTTP provides no confidentiality or integrity against an on-path network participant. The Tailscale address range can also exist in non-Tailscale carrier-grade NAT environments; pairing it with a local destination in the same range narrows but does not prove Tailscale transport.

Interface sampling is a startup snapshot. Address, route, or VPN changes require a restart, and forwarding headers never expand the actual socket policy. These limits keep proxy identity and dynamic network discovery out of this decision.

The browser-token, browser-trust, and all-interface Agent Notes remain active. Each retains independently useful security rationale, while this decision cross-links and partially supersedes only their uniform-authentication and unauthenticated-serving claims.
