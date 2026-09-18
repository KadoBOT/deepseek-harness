# Agent Note: 脱离子任务的委派期限

Status: proposed

[English](2026-09-14-delegation-deadlines-for-detached-children.md) | 中文

## Problem

脱离后的子任务没有墙钟。前景委派随调用返回，但 one-shot 后台任务在 spawn 处解决，可继续子任务在收件确认处解决（`packages/subagent/tool-subagent/src/index.ts:529-563`）；此后子任务一直运行，直到自行停止或被祖先打断。`ToolDefinition.timeoutMs` 到不了这些路径：它只约束一次同步 `tools/execute` 跨度，而 one-shot 后台路径自建了与 `exec.signal` 脱钩的 `AbortController`（`:552`），可继续路径在确认处脱离（`:530-539`）。打断权限只承认 `user` 与 `ancestor`（`packages/subagent/subagent/src/continuation.ts:125-127, 730-762`）；不存在 manager 或系统角色。结算词汇已按 diagnostic 有无区分结局——无 diagnostic 的 `aborted` 落为 `killed`，有的落为 `failed`（`packages/subagent/subagent/src/run-settlement.ts:37-53`）——但没有已发布的提供方把 `signal.reason` 映射为 diagnostic，因此裸 abort 与用户 kill 无法区分。

## Proposal

在拥有每条脱离路径的那一层执行期限，复用 killed-versus-failed 区分，不新增停止原因变体。

在 `tool-subagent` 上新增可选的 `deadlineMs` 合法 Config 字段（自然数毫秒；缺省保留今天无上限的行为）。`ToolDefinition.timeoutMs` 继续不用：它只产生无部分结果的 `TOOL_TIMEOUT` 错误，结构上到不了脱离路径。

对 one-shot 后台任务与前景调用，工具在任务/运行控制器上自建计时器。到期后以期限原因 abort，结算包装把期限触发的结局转为 `failed`，detail 为 `delegation deadline exceeded after {N}ms: {label}; split the task and delegate per phase instead of retrying unchanged`。计时器归 fiber 所有，在 settle、cancel、dispose 时清除，不让句柄活过自己的任务。用户取消仍以无 diagnostic 落为 `killed`，两种结局通过既有结算映射保持可区分。

对可继续子任务，`deadlineMs` 经 `startContinuable` 传入（边界处合法性校验，从不持久化——描述符版本不动），继续管理器在收件确认处 armed 计时器。到期后直接以 parent 原因取消当前轮次——不新增公开权限变体，不改变鉴权面——并标记 Activation，使结算通知能区分期限打断与自然结束。父级的后续投递会解除计时器并重置标记：重新介入是一项新的委托，因此期限只约束最初无人值守的运行，而那正是超大 fire-and-forget 委派真正危险的窗口。

期限 detail 指示拆分不重试，堵住父原样重试同一超大任务的 double-burn 循环；措辞引用[规模指引与可见上限](2026-09-14-delegation-sizing-guidance-and-legible-caps.zh.md)中的规模指引。

## Alternatives considered

**从 Config 声明 `ToolDefinition.timeoutMs`。** 已拒绝，因为超时策略守卫只报无部分结果的 `TOOL_TIMEOUT`，而且结构上到不了作为动机的脱离后台与可继续路径。

**新增 `deadline` 停止原因变体。** 对 one-shot 运行已拒绝：diagnostic 有无已把用户 kill（`killed`）与期限到期（`failed`）分开，停止原因映射保持更小更好；可继续标记放在 Activation 与结算通知上。

**像 `depthLimit` 那样把期限做成能力门。** 已拒绝，因为所有提供方本来就服从 abort 信号；不会有提供方拒绝该能力，加门只是没有拒绝者的仪式。

**到期硬杀子任务。** 已拒绝，因为不存在这种机制：按架构取消是协作式的，忽略信号的提供方会继续运行，超时策略守卫的文档正是如此。

## Acceptance criteria

- 带期限的 hanging 提供方固件以 `failed` 结算并携带期限 detail；同一固件经 `job_kill` 仍以无 diagnostic 落为 `killed`。
- 前景期限返回带期限 detail 的错误结果，并保留子的部分 assistant 文本。
- 可继续期限直接以 parent 原因取消当前轮次，结算通知携带标记；父级重新介入的投递会解除它；无期限行为不变。
- Config 在加载期拒绝非自然数的 `deadlineMs`。
- 默认缺席的期限不改变任何模型可见文本，既有快照原样回放。

## Risks

- 执行保持协作式：忽略 abort 信号的提供方会在到期后继续运行；有保证的是结算标记那一半，不是终止那一半。
- 期限可能切断合理耗时的工作：到期按实例 opt-in，部署方调值，detail 会告诉父发生了什么。
- 计时器生命周期必须在每条路径（settle、cancel、dispose）上清除；泄漏的句柄会活过自己的任务，因此 dispose 覆盖是承重的。
- 墙钟毫秒包含笔记本睡眠与挂起；调度突发性强的部署应据此取值。
