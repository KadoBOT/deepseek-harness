# dsh-antigravity

Standalone Cordis plugin for the Google Antigravity (`agy`) CLI bridge.

Bridges DeepSeek Harness model requests to the local Google Antigravity CLI binary without requiring direct API keys or modifying core LLM packages.

## Capabilities

- **Automatic CLI Resolution**: Discovers the `agy` binary in standard candidate locations (`~/.local/bin/agy`, `/opt/homebrew/bin/agy`, `/usr/local/bin/agy`, or `PATH`).
- **Supported Models** (exact `agy models` ids — effort variants, not base ids):
  - `gemini-3.8-flash-high`, `gemini-3.8-flash-medium`, `gemini-3.8-flash-low`
  - `gemini-3.7-flash-high`, `gemini-3.7-flash-medium`, `gemini-3.7-flash-low`
  - `gemini-3.6-flash-high`, `gemini-3.6-flash-medium`, `gemini-3.6-flash-low`
  - `gemini-3.1-pro-high`, `gemini-3.1-pro-low`
  - `claude-sonnet-4-6`
  - `claude-opus-4-6-thinking`
  - `gpt-oss-120b-medium`
- **Reasoning Effort Mapping**: a picked variant without an effort override is used as-is; otherwise `reasoningEffort` (`high`, `medium`, `low`) remaps within the same model family. Older settings pinning base ids (e.g. `gemini-3.8-flash`) keep working through the same mapping.
- **Waterfall Interception**: Listens to `ctx.on("llm/stream")` for routes targeting `antigravity` or `google`, streaming NDJSON responses from `agy` directly into DSH stream chunks.

## Installation

Add to your profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: antigravity
      name: "dsh-antigravity"
```
