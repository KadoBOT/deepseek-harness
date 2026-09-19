# dsh-orchestrator

Durable role routing for the orchestrator preset: Settings → Orchestrator, plus `delegate_*` / `orchestrator_dispatch` tools that sample that table on every call.

## Accounts

Settings → Orchestrator → **Accounts** connects more than one account per provider. An account is one LLM route owned by this plugin:

```yaml
orchestrator-accounts:
  accounts:
    - id: xai-work            # route key and credential-record id
      product: xai            # the pi-ai provider whose models and sign-in this account uses
      label: Grok (work)      # the name every provider list shows
    - id: openai-codex-personal
      product: openai-codex
      label: ChatGPT (personal)
```

`product` is any installed pi-ai provider — `xai`, `openai-codex`, `openai`, `anthropic`, `google`, and so on. The account borrows that provider's endpoint, wire protocol, and auth methods while keeping its own id, name, and stored credential, so two Grok or two ChatGPT accounts appear as two selectable providers in every role row, exactly like two different vendors. Its models are inherited from the served base route of the same product — ids, order, and tuned capacities overlaid on catalog richness — falling back to the installed catalog where the base route is absent; editing the base route re-syncs its accounts through `llm/adapters-updated`. Accounts configure no model list of their own and the Models page offers none for them.

**Save accounts** writes the list; the Host registers one route per account immediately (`llm/adapters-updated` refreshes the page's provider lists). **Connect** runs that product's own sign-in — the ChatGPT sign-in for `openai-codex`, "Sign in with SuperGrok or X Premium" for `xai`, an API-key prompt for products that have no OAuth — and streams its notices, links, device codes, and questions into the settings page. The credential is committed on the Host side; only the resulting identity (an email or account id) is shown. **Disconnect** deletes the stored credential.

Requests on an account route are served by `llm-pi-ai`'s own exported `PiAiAdapter`, so context conversion, streaming, retry, reasoning effort, and image handling are the same code path as any other pi-ai route. Grants live under the credential scope `dsh-orchestrator` (`dsh-orchestrator/<account id>`), separate from `llm-pi-ai/*` records, and pi-ai rotates their tokens through this plugin's store lock. Editing an `id` orphans the credential stored under the old one: connect again after a rename.

`google` in the installed pi-ai catalog offers an API key, not an OAuth sign-in, so a Gemini subscription account still goes through the `dsh-antigravity` plugin's `agy` bridge; an account route for `google` authenticates with a key.

### Sign-in transport

The settings page cannot call a Host method for this: the application Remote assembly selects its namespaces at build time and an out-of-tree plugin adds none. The plugin therefore owns four routes on the web GUI's HTTP server — `GET /orchestrator/accounts` (status), `POST /orchestrator/accounts/connect` (Server-Sent Events), `POST /orchestrator/accounts/answer`, `POST /orchestrator/accounts/disconnect` — and every one of them defers to `connection.requestRejection`, the same request policy the GUI's own bridge applies. No token ever crosses the wire in either direction. One sign-in per account runs at a time, and an attempt is abandoned with the browser that started it.

## Routing

Each role (`explorer`, `worker`, `tester`, `researcher`, `reviewer`, `imagegen`) stores an ordered list of `{provider, model, reasoningEffort}`. An empty list inherits the chat-box orchestrator model. After every pinned route fails, the inherited orchestrator model is tried once. Cancellation never falls back.

A legacy single `{provider, model, reasoningEffort}` object in `settings.yaml` is still read as a one-route list.

Routes are not pinned onto the parent session. A Settings change applies to the next dispatch in the same conversation and after stop/resume. A worker that is already running keeps the model it started with.

Each role spawn applies its own DSH toolbelt. Explorer, researcher, and reviewer cannot write. Imagegen cannot fetch the web or nest subagents and is the only role that keeps `image_gen`. Chat adapters do not forward Grok, Gemini, or OpenAI product tools; `image_gen` is the harness-side image endpoint for those providers.

Worker text returned to the parent is capped at 12000 chars (8000 head + 2000 tail with a truncation notice) so one large worker dump cannot overflow the orchestrator context.

## Image generation

`imagegen` is a worker on a Grok (`xai`), Gemini (`google`), OpenAI (`openai`), or Codex (`openai-codex`) chat route. Those products have a native `image_gen` tool; the harness chat adapters do not forward it, so this plugin registers a DSH `image_gen` tool that calls the matching xAI / Gemini / OpenAI image endpoints with the same stored Models credentials. A Codex worker instead calls the ChatGPT backend's Responses `image_generation` tool with the stored OAuth grant (rotating it when stale), billed to the ChatGPT subscription. Imagegen dispatches deny web fetch and nested subagents so the worker cannot fall back to third-party hosts.

On OpenAI/Codex rows the Settings model dropdown lists the image models first (`gpt-image-2.5-flare`, `gpt-image-2.5-sunburst`, `gpt-image-2.5`, `gpt-image-2`): picking one pins that endpoint, while picking a chat model tries the image list in order. A pinned image model cannot chat, so the worker spawns on the provider's first live non-image chat model and is instructed to pass the pinned id as `image_gen`'s `model` parameter (also callable directly).

The chat dropdown next to it picks the turn's text model (empty resolves live at dispatch). Selecting an OpenAI/Codex provider presets it to `gpt-5.6-luna` with effort `low` when the catalog offers them. The row effort drives both the worker and the image turn's reasoning effort (unknown dialects are omitted; a reasoning rejection retries the turn once without effort).

`image_gen` takes an optional `references` array of workspace image paths (`.png`, `.jpg`, `.webp`). On Codex routes they attach as `input_image` parts of the same Responses turn, so the generation can follow, restyle, or edit them — e.g. `references: ["logo.png"]` with prompt `"put this logo on a coffee mug"`. Other providers reject references. An optional `size` (`1024x1024`, `1536x1024`, `1024x1536`, `auto`) steers the Codex output dimensions; omit it for the backend default.

## Reload

Host plugin JS is loaded once per `dsh web` process. After editing anything under `src/`, restart that same web process yourself, then refresh http://127.0.0.1:3080. Do not start a second server, and do not kill the GUI from inside a session it is serving. `src/client.js` is served to the browser on every load, so a refresh alone picks up settings-page changes.

There is no build step: plain JS loads straight from `src/`. Tests run against `src/` from the plugin directory:

```sh
node --test "tests/*.spec.js"
```

Account routes are served by the `PiAiAdapter` that ships in `@deepseek-ai/dsh-llm-pi-ai`; the plugin loads that library and its provider catalog from the adapter's own installation (`loadPiAi`), because only the harness packages are hoisted beside an out-of-tree plugin. If that library cannot be found, the plugin logs one warning and everything except accounts keeps working.
