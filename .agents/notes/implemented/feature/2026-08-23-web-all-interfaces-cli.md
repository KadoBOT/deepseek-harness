# Agent Note: CLI all-interfaces web serving

Status: implemented

English | [中文](2026-08-23-web-all-interfaces-cli.zh.md)

## Problem

The [explicit web bind address](2026-07-22-web-bind-address.md) decision names `--host 0.0.0.0` as `dsh web`'s explicit all-interface mode, and both the HTTP carrier schema and the [`/api` browser-trust fence](../architecture/2026-07-28-api-browser-trust-boundary.md) support that deployment: the fence accepts port-less LAN IP literals derived from the machine's interfaces. The CLI still exited with a usage error on the wildcard value, so a LAN browser had no supported way to reach the GUI without hand-written patch layers overriding the webserver row.

## Decision

`dsh web --host` accepts exactly `127.0.0.1` and `0.0.0.0`; any other value exits with a usage error before any server row evaluates. All-interfaces mode keeps printing the loopback URL line, appends the first sampled LAN IPv4 URL, and states the cost once next to it: the server is unauthenticated, so anyone who can reach the port can drive this harness. The invocation's LAN literals reach the trust fence port-less through `webRuntime`, alongside explicit `--trusted-host` entries; loopback-gated methods stay loopback-only.

## Alternatives considered

**Keep refusing the wildcard value and require patch layers for LAN use.** Rejected because the shipped command could not express the network mode its own bind-address decision names, pushing operators into composition surgery to override one config row.

**Require an explicit `--trusted-host` declaration before LAN requests pass the fence.** Rejected because the operator makes the exposure choice with the bind flag itself, and DHCP reassignments silently invalidate typed lists; port-less IP literals sampled from the machine are the form the fence's rebinding defense actually needs.

## Consequences

One flag exposes remote code execution to every reachable interface without credentials; protection is the Host fence against browser-borne DNS rebinding and cross-site requests, nothing else, so the documented trusted-network assumption of an unauthenticated `0.0.0.0` deployment is reachable from the shipped CLI. LAN sampling happens once at activation, so an address acquired later needs a restart or a declared authority. Custom interface addresses and IPv6 binds remain unsupported at both the CLI and the carrier schema.
