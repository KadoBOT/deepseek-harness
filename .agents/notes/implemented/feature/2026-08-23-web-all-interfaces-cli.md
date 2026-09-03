# Agent Note: CLI all-interfaces web serving

Status: implemented

English | [中文](2026-08-23-web-all-interfaces-cli.zh.md)

## Problem

The [explicit web bind address](2026-07-22-web-bind-address.md) decision names `--host 0.0.0.0` as `dsh web`'s explicit all-interface mode, and both the HTTP carrier schema and the [`/api` browser-trust fence](../architecture/2026-07-28-api-browser-trust-boundary.md) support that deployment: the fence accepts port-less LAN IP literals derived from the machine's interfaces. The CLI still exited with a usage error on the wildcard value, so a LAN browser had no supported way to reach the GUI without hand-written patch layers overriding the webserver row.

## Decision

`dsh web --host` accepts exactly `127.0.0.1` and `0.0.0.0`; any other value exits with a usage error before any server row evaluates. All-interfaces mode keeps printing the tokenized loopback URL and appends the first sampled non-internal IPv4 URL with the same browser credential requirement. The invocation's IP literals reach the trust fence port-less through `webRuntime`, alongside explicit `--trusted-host` entries.

The separate [`--allow-unauthenticated-network` decision](../architecture/2026-09-03-trusted-network-browser-authentication.md) permits only derived RFC 1918 and Tailscale socket peers to omit that credential. It requires the explicit all-interface host and prints a clean network URL while loopback remains tokenized.

## Alternatives considered

**Keep refusing the wildcard value and require patch layers for LAN use.** Rejected because the shipped command could not express the network mode its own bind-address decision names, pushing operators into composition surgery to override one config row.

**Require an explicit `--trusted-host` declaration before LAN requests pass the fence.** Rejected because the operator makes the exposure choice with the bind flag itself, and DHCP reassignments silently invalidate typed lists; port-less IP literals sampled from the machine are the form the fence's rebinding defense actually needs.

## Consequences

The bind flag exposes the HTTP server to every reachable interface, while Connection's Host fence and browser session still protect Host API and WebSocket access. The explicit trusted-network flag can grant complete tool authority to matching private peers over plaintext HTTP; binding and authentication remain separate operator choices. Interface sampling happens once at activation, so an address acquired later needs a restart or a declared authority. Custom interface addresses and IPv6 binds remain unsupported at both the CLI and the carrier schema.
