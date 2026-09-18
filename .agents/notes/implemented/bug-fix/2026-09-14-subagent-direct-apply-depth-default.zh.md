# Agent Note: 直接 apply 的委派执行默认深度预算

Status: implemented

[English](2026-09-14-subagent-direct-apply-depth-default.md) | 中文

## Problem

`dsh-tool-subagent` 在 Schemastery Config schema 中声明 `maxDepth` 默认值（`3`），但该默认值只在 Loader 路径下生效。直接调用 `apply()` 会绕过 Schemastery，因此省略 `maxDepth` 时实际不带任何上限：启动请求中没有预算，缺少 `depthLimit` 能力的提供方也会静默挂载而不报错。同一个插件的两个入口于是执行着两种不同的递归预算，而更安静的那个入口恰恰是无上限的。

## Decision

`packages/subagent/tool-subagent/src/index.ts` 导出 `DEFAULT_MAX_DEPTH` 作为唯一的事实来源，同时用于 schema 默认值，并在 `apply()` 中把直接调用时的缺省解析到该值。挂载时的能力检查与启动请求中的预算都使用解析后的值；只有显式配置 `maxDepth: 'provider-managed'` 才不发送上限，与面向进程外提供方的文档一致。该改动与[子委派深度](../feature/2026-07-12-subagent-persona-tool-filter-and-depth.zh.md)中的深度预算决策保持一致，本记录不改变该决策。

## Alternatives considered

**保留直接 apply 缺省时无上限的行为。** 已拒绝，因为同一个插件的两个入口会执行不同预算，而静默的那个入口恰恰无上限；递归上限若取决于哪个调用者挂载了插件，就不算上限。

**在回退路径中重复字面量 `3`。** 已拒绝，因为 schema 默认值与回退值会各自漂移；导出一个常量才能从构造上保证两者一致。

**拒绝未经 Schemastery 的直接 `apply()`。** 已拒绝，因为手写组合与包内测试绕过 Loader 是合法用法，与 ACP 智能体后端处理默认值的方式一致。

## Consequences

- 每个 `tool-subagent` 实例都执行数字深度预算，除非其部署显式使用 `'provider-managed'` 退出。
- 直接 apply 把缺少 `depthLimit` 的提供方挂载时，现在会大声失败而不是无上限运行；六个在无能力提供方上测试后台与预检机制的既有测试已显式声明退出。
- 没有改变任何模型可见文本，因此不需要重新录制快照。

## Testing

`packages/subagent/tool-subagent/tests/tool-subagent.spec.ts` 锁定新行为：直接 apply 缺省时在启动请求中转发 `maxDepth: 3`，对缺少 `depthLimit` 的提供方直接 apply 缺省时在挂载期拒绝。完整包套件（155 个测试）、`tsc --noEmit`、`oxlint` 与无密钥的子智能体快照回放全部通过。

## Deferred

- 在委派工具描述中加入任务规模指引（一个子任务对应一个可验证交付物；多阶段工作拆分；写明期望输出规模）。该文本涉及数十个快照文件，需要有密钥的重新录制，而当前没有密钥；指引应放在描述文本中——根据 [fork 前缀复用决策](../architecture/2026-08-10-fork-children-stay-one-shot.zh.md)，父子共享完全相同的描述——而不是新增 section。
- 为脱离的后台与可继续子任务设置委派期限。`ToolDefinition.timeoutMs` 只约束一次同步工具调用，因此执行点应在任务控制器与继续管理器上，而不是工具定义。
- 循环层面的轮次预算。插件层面的 pre-step 拒绝会表现为 `refusal`，因此独立的停止原因需要在 `agent-loop` 中做 `TurnEndReasonMap` 变更，并同步更新架构文档。
- 在 `started` 与 `settled` 之间加入子到父的进度信号。今天不存在这类通道，而它的缺失比规模指引更可能是超大任务的根因。
