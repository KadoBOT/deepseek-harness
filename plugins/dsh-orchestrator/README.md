# dsh-orchestrator

Durable role routing for the orchestrator preset: Settings → Orchestrator, plus `delegate_*` / `orchestrator_dispatch` tools that sample that table on every call.

## Routing

Each role (`explorer`, `worker`, `tester`, `researcher`, `reviewer`, `imagegen`) stores an ordered list of `{provider, model, reasoningEffort}`. An empty list inherits the chat-box orchestrator model. After every pinned route fails, the inherited orchestrator model is tried once. Cancellation never falls back.

A legacy single `{provider, model, reasoningEffort}` object in `settings.yaml` is still read as a one-route list.

Routes are not pinned onto the parent session. A Settings change applies to the next dispatch in the same conversation and after stop/resume. A worker that is already running keeps the model it started with.

Each role spawn applies its own DSH toolbelt. Explorer, researcher, and reviewer cannot write. Imagegen cannot fetch the web or nest subagents and is the only role that keeps `image_gen`. Chat adapters do not forward Grok or Gemini product tools; `image_gen` is the harness-side image endpoint for those providers.

## Image generation

`imagegen` is a worker on a Grok (`xai`) or Gemini (`google`) chat route. Those products have a native `image_gen` tool; the harness chat adapters do not forward it, so this plugin registers a DSH `image_gen` tool that calls the matching xAI / Gemini image endpoints with the same stored Models credentials. Imagegen dispatches deny web fetch and nested subagents so the worker cannot fall back to third-party hosts.

## Reload

Host plugin JS is loaded once per `dsh web` process. After editing `lib/index.js`, restart that same web process yourself, then refresh http://127.0.0.1:3080. Do not start a second server, and do not kill the GUI from inside a session it is serving.
