# dsh-antigravity

Standalone Cordis plugin for the Google Antigravity (`agy`) CLI bridge.

Bridges DeepSeek Harness model requests to the local Google Antigravity CLI binary without requiring direct API keys or modifying core LLM packages.

## Capabilities

- **Automatic CLI Resolution**: Discovers the `agy` binary in standard candidate locations (`~/.local/bin/agy`, `/opt/homebrew/bin/agy`, `/usr/local/bin/agy`, or `PATH`).
- **Supported Models**:
  - `gemini-3.8-flash`
  - `gemini-3.7-flash`
  - `gemini-3.6-flash`
  - `gemini-3.1-pro`
  - `claude-sonnet-4-6`
  - `claude-opus-4-6-thinking`
  - `gpt-oss-120b-medium`
- **Reasoning Effort Mapping**: Automatically maps `reasoningEffort` (`high`, `medium`, `low`) to `agy` model variants.
- **Waterfall Interception**: Listens to `ctx.on("llm/stream")` for routes targeting `antigravity` or `google`, streaming NDJSON responses from `agy` directly into DSH stream chunks.

## Installation

Add to your profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: antigravity
      name: "dsh-antigravity"
```
