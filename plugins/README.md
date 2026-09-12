# Standalone Cordis Plugins

This directory contains standalone Cordis plugins that extend DeepSeek Harness without modifying core packages under `packages/`.

By keeping these plugins external to the core repository packages, DeepSeek Harness core can remain clean and track upstream updates without merge conflicts.

## Available Plugins

- [`dsh-orchestrator`](./dsh-orchestrator/README.md): Role-based routing (`explorer`, `worker`, `tester`, `researcher`, `reviewer`, `imagegen`), Settings UI, and delegation tools.
- [`dsh-antigravity`](./dsh-antigravity/README.md): Local Google Antigravity (`agy`) CLI streaming bridge for Gemini, Claude, and GPT-OSS models.

## Usage

Mount plugins into your profile (e.g. `~/.dsh/profiles/web/cordis.patch.yml`):

```yaml
- insert:
    - id: orchestrator
      name: "dsh-orchestrator"
    - id: antigravity
      name: "dsh-antigravity"
```
