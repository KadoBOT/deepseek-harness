# Agent Note: 委派工具的规模指引与可见上限

Status: proposed

[English](2026-09-14-delegation-sizing-guidance-and-legible-caps.md) | 中文

## Problem

委派工具只说明如何委派，从不说明一次委派多大规模。`providerWording()`（`packages/subagent/tool-subagent/src/index.ts`）中的 `subagent` 描述只讲 child 是什么，不讲什么规模适合装进一个 child；`workflow` 描述（`packages/workflow/tool-workflow/src/index.ts`）把 hook 讲得很精确，却只用一句没给出数字的 "concurrency and total-agent caps apply" 带过上限，模型只有在触发某条上限、看到报错字符串之后，才知道真实数字（并发 `min(16, cores-2)`、每轮 1000 个 agent、每次调用 4096 个条目、50000 结果字符）。[直接 apply 深度预算](../../implemented/bug-fix/2026-09-14-subagent-direct-apply-depth-default.zh.md)补上了一个预算漏洞；但任务规模本身依然没有指引，而那一轮没有可用于快照重录的 API 密钥，本改动恰恰需要重录。

## Proposal

把规模契约放进工具描述，因为描述能对称到达每个实例：在 join 的 preset 下，父与 fork 子拥有完全相同的工具描述，包括从没有 prompt section 的 one-shot fork 与进程外后端。

在两个 `providerWording()` 描述（fresh 与 fork）中、背景后缀之前，追加这一句：

```text
Scope each delegation to one verifiable deliverable the child can finish and report back; split multi-phase work into one delegation per phase, and do the work inline when it needs at most a couple of tool calls.
```

在两个 `promptDescription` 字符串中追加这一句：

```text
State the expected shape and size of the result.
```

把 workflow 上限从配置渲染出来，而不是不给数字。`tool-workflow` 拥有 `maxResultChars`；引擎拥有并发、总量与单次调用条目上限，因此 workflow 服务 seam 新增 `limits()` 访问器，由 worker-thread 引擎实现，描述模板采用解析后的值：

```text
Constraints: at most {concurrency} agents run at once, {total} agents per run, {items} items per agent() call, and {chars} result characters; no filesystem, network, timers, or Node.js APIs are provided — the agents do the work, the script only coordinates them. The run executes in the foreground: this call returns when the whole script finishes.
```

注册时若没有挂载引擎，保留当前通用句子作为回退。单元测试逐字锁定两种措辞中的规模指引句，并断言 workflow 描述中出现配置的数字；快照语料用密钥重录、无密钥回放。

## Alternatives considered

**新增一个规模指引 prompt section。** 已拒绝，因为 section 注册以 background-plus-continuable 为条件，one-shot fork 与进程外工具依然拿不到；描述文本是每个实例本来就有的唯一通道。

**在描述中写死字面量数字。** 已拒绝，因为随部署变化的值必须是合法 Config 字段；字面量会与引擎配置漂移。

**只讲形状不给数字。** 保留为引擎缺席时的回退，已拒绝作为常态：模型看不见的边界，是它无法据以规划的边界。

**把规模指引放进部署 persona。** 按约定拒绝：工具指引属于工具插件的 prompt section 与描述，不属于部署 persona。

## Acceptance criteria

- 两种 `subagent` 措辞在各种后台模式下都包含规模指引句；包内测试逐字断言。
- `workflow` 描述渲染配置的数字，含非默认 Config 值；引擎缺席回退有覆盖。
- 用 API 密钥重录快照语料；完整无密钥 `test:snapshot` 与 `test:docs` 变绿。
- 描述长度增量在改动中度量并记录。

## Risks

- 指引的遵守情况不可度量：快照锁定指引文本，从不断言模型是否遵守；可见上限才是本改动中可执行的一半。
- 加长的描述在部署时使缓存的请求前缀一次性失效；之后前缀保持稳定。
- 工具注册后若引擎配置变更，渲染的上限可能过期；在引擎变更时重新解析的方案未定。
