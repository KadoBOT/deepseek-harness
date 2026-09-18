---
description: "The OAuth agent-connections plugin for users and maintainers signing the harness into ChatGPT/Codex, Grok, and Gemini accounts and routing the LLM service through them."
kind: "package-reference"
---

# @deepseek-ai/dsh-oauth-agents

English | [中文](README.zh.md)

## Summary

`@deepseek-ai/dsh-oauth-agents` connects the harness to external AI provider accounts through OAuth: Google (Gemini Code Assist), ChatGPT/Codex, and Grok/xAI. The plugin owns the Gemini Code Assist authorization flow, credential record, and LLM adapter end to end — browser sign-in, code exchange, token refresh under the credential store's cross-process lock, and the `:streamGenerateContent` SSE protocol mapped onto the harness message and stream vocabulary. ChatGPT and Grok ride the `llm-pi-ai` adapter's own authorization flows; this plugin drives their attempts, converges their settings profiles after a grant, and can save the provider as the session default model. A connect surface for humans and models registers the `oauth_agent_connect` and `oauth_agent_status` tools and the `/connect` and `/oauth-status` commands; the browser half adds a Models-page footer card that runs the same commands from Settings → Models.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin when a composition should sign in to ChatGPT, Grok, or Gemini accounts and route model requests through them. The plugin requires the `authorization` service — mount an authorization provider such as `@deepseek-ai/dsh-authorization` beside it — and injects the `llm`, `credentials`, `subprocess`, `userQuestions`, `commands`, `timer`, and `tools` services.

### Connect a provider

The model tool `oauth_agent_connect` takes `provider` (`chatgpt`, `grok`, or `gemini`), an optional `setAsDefault`, and an optional `model`. The `/connect <provider>` command runs the same attempt from chat. Both paths:

1. Resolve the provider's registered authorization flow and begin it.
2. Bridge the flow's interaction onto the ask-user surface: the browser URL appears as a notice, and prompts render as questions.
3. After a grant, add the provider's settings profile (`llm-pi-ai` namespace for ChatGPT and Grok) and, when asked, save the route as the default-model selection.

Gemini's flow is this plugin's own: it opens the Google consent page, asks for the authorization code Google shows after account selection, exchanges the code, reads the display email, and stores the grant as the `oauth-agents/gemini` credential record. The first generate call onboards the account's free-tier Code Assist project and caches it in the same record.

### Check status

`oauth_agent_status` and `/oauth-status` report, per provider, whether the credential record is configured and whether the provider's LLM route is live. The Models-page footer card runs `/oauth-status` and renders its text verbatim.

<a id="model-experience"></a>
## Model Experience

- **Tokens and KV cache**: the plugin adds two tool schemas (~350 tokens with descriptions) and three command descriptions. Model output streams token-by-token; reasoning thoughts stream as reasoning deltas and are not re-sent. A Gemini tool call round-trips as one `functionCall` part plus one `functionResponse` part.
- **Context reuse**: conversation history is re-sent each request as the Code Assist `contents` envelope; nothing is cached provider-side. The access token refreshes at most once per request when within two minutes of expiry, on the credential store's cross-process lock.
- **Failure surface**: transport and provider failures carry the neutral `LlmFailure` vocabulary (`AUTH`, `RATE_LIMIT`, `PROTOCOL`, `NO_CREDENTIAL`), so retry policy and user messaging stay provider-agnostic.

<a id="known-limitations"></a>
## Known Limitations and Deferred Work

- **No real-composition test yet.** The product-visible surfaces (Models-page footer card, authorization flow, command set) are exercised manually against the running harness; a boot-level `cordis.yml` test that mocks only the Google endpoints is deferred.
- **Static Gemini model catalog.** Model ids, context windows, and max-token values are a hand-maintained list; no `listModels` round trip reconciles it with the tenant.
- **No image or audio modalities.** The adapter declares text-only input and output; multimodal Gemini requests are deferred.
- **Client status rides command text.** The Models-page card renders `/oauth-status` output verbatim instead of a typed Remote namespace; a typed status view is deferred until the record half grows a Remote seam.