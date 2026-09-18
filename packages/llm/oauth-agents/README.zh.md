---
description: "面向用户与维护者的 OAuth 代理连接插件：将 harness 登录到 ChatGPT/Codex、Grok 与 Gemini 账号，并让 LLM 服务经由它们路由。"
kind: "package-reference"
---

# @deepseek-ai/dsh-oauth-agents

[English](README.md) | 中文

## Summary

`@deepseek-ai/dsh-oauth-agents` 通过 OAuth 把 harness 连接到外部 AI 服务商账号：Google（Gemini Code Assist）、ChatGPT/Codex 与 Grok/xAI。插件端到端地拥有 Gemini Code Assist 的授权流程、凭据记录与 LLM 适配器——浏览器登录、授权码交换、在凭据存储的跨进程锁下刷新令牌，以及把 `:streamGenerateContent` SSE 协议映射到 harness 的消息与流词汇。ChatGPT 与 Grok 复用 `llm-pi-ai` 适配器自己的授权流程；本插件驱动它们的登录尝试，在授权完成后收敛其设置档案，并可把该服务商保存为会话默认模型。面向人与模型的连接入口注册 `oauth_agent_connect` 与 `oauth_agent_status` 工具以及 `/connect`、`/oauth-status` 命令；浏览器侧在 Settings → Models 页面新增页脚卡片，从设置页直接运行同样的命令。

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

当组合需要登录 ChatGPT、Grok 或 Gemini 账号并经由它们路由模型请求时挂载本插件。插件要求 `authorization` 服务——在它旁边挂载 `@deepseek-ai/dsh-authorization` 之类的授权提供者——并注入 `llm`、`credentials`、`subprocess`、`userQuestions`、`commands`、`timer` 与 `tools` 服务。

### 连接服务商

模型工具 `oauth_agent_connect` 接受 `provider`（`chatgpt`、`grok` 或 `gemini`）、可选的 `setAsDefault` 与 `model`。`/connect <provider>` 命令在聊天里运行同样的尝试。两条路径都会：

1. 解析该服务商已注册的授权流程并启动它。
2. 把流程的交互桥接到提问面板：浏览器 URL 以通知出现，提示以问题呈现。
3. 授权完成后，添加该服务商的设置档案（ChatGPT 与 Grok 在 `llm-pi-ai` 命名空间），并在被要求时把该路由保存为默认模型选择。

Gemini 的流程是本插件自己的：打开 Google 同意页，要求粘贴选择账号后 Google 展示的授权码，交换该码，读取展示用的邮箱，并把授权结果存为 `oauth-agents/gemini` 凭据记录。首次生成调用会为账号开通免费层 Code Assist 项目并缓存在同一记录里。

### 查看状态

`oauth_agent_status` 与 `/oauth-status` 逐个报告每个服务商的凭据记录是否已配置、其 LLM 路由是否可用。Models 页面页脚卡片运行 `/oauth-status` 并原样渲染其文本。

<a id="model-experience"></a>
## Model Experience

- **Token 与 KV cache**：插件新增两个工具 schema（含描述约 350 token）与三条命令描述。模型输出逐 token 流式返回；思考内容以 reasoning delta 流式出现且不会被重发。Gemini 的工具调用往返为一个 `functionCall` 部件加一个 `functionResponse` 部件。
- **上下文复用**：每次请求把会话历史整体重发为 Code Assist `contents` 信封；服务商侧不缓存任何内容。距过期两分钟以内的访问令牌至多每请求刷新一次，且运行在凭据存储的跨进程锁上。
- **失败面**：传输与服务商失败携带中性的 `LlmFailure` 词汇（`AUTH`、`RATE_LIMIT`、`PROTOCOL`、`NO_CREDENTIAL`），重试策略与用户提示保持与服务商无关。

<a id="known-limitations"></a>
## Known Limitations and Deferred Work

- **尚无真实组合测试。** 产品可见面（Models 页脚卡片、授权流程、命令集）目前对着运行中的 harness 手工验证；只 mock Google 端点的 `cordis.yml` 启动级测试被推迟。
- **静态 Gemini 模型目录。** 模型 id、上下文窗口与最大 token 值是手工维护的列表；没有 `listModels` 往返与租户核对。
- **不支持图像与音频模态。** 适配器只声明文本输入与输出；多模态 Gemini 请求被推迟。
- **客户端状态依赖命令文本。** Models 页面卡片原样渲染 `/oauth-status` 输出而不是类型化 Remote 命名空间；等记录半区长出 Remote 缝之后再做类型化状态视图。