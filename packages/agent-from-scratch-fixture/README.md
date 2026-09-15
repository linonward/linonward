# @linonward/agent-from-scratch-fixture

`apps/tutorial` 中文教程主线 18 章逐步搭出来的 `agent-from-scratch` 项目的**可执行参考实现**。

教程每一章都在同一个项目上增量修改，但教程本身没有附带一个"把每一章增量都应用上去"的可执行工程。
这个包就是那个缺口：它把主线所有章节的代码块合并成一份可以 `typecheck`、可以 `test`、可以 `lint`
的离线工程，用来验证教程给出的每个契约真的能编译、能运行、能测。

## 不做什么

- 不调用真实模型、不访问网络、不读取 `OPENAI_API_KEY`。模型边界统一是 `Model` / `ModelDriver`，
  离线路径由 `FakeModel` / `FakeModelDriver` 满足。
- 不依赖 `openai` 包：`ResponsesClientLike` 是一个结构类型，真实项目里由 SDK 满足它，
  fixture 里由测试注入结构替身。
- **扩展篇不在此 fixture 范围内**：`apps/tutorial/src/content/extensions/` 下的
  multi-agent、MCP、RAG、browser-automation、parallel-orchestration、voice 复用主线建立的
  `Model`/`Context`/`Tool`/`Policy`/`State`/`Trace`/`Eval` 边界，但不是本包要交付的实现。

## 如何运行

```sh
# 只跑这个包的三个门禁
pnpm turbo run test typecheck lint --filter=@linonward/agent-from-scratch-fixture

# 也可以直接进入包目录
cd packages/agent-from-scratch-fixture
pnpm test
pnpm typecheck
pnpm lint
```

CLI 装配在 `src/index.ts`：`parseCliArgs` / `runCli` / `createAgentCliRuntime` 实现了
`run` / `resume` / `answer` 三个子命令、退出码、`onEvent` 打印与 `AbortSignal` 传播。
`main` 入口刻意不连接真实模型——真实 `ModelDriver`、`Planner`、`ToolRegistry` 由嵌入方通过
`createAgentCliRuntime` 注入；测试里用替身驱动同一条链路（见 `tests/cli.test.ts`）。

## 章节 → 模块 → 测试

| 章 | 章节 | 主要模块 | 测试文件 |
| --- | --- | --- | --- |
| 00 | 开始 | `package.json`、`tsconfig.json`、`src/index.ts` | `tests/cli.test.ts` |
| 01 | 最小模型调用 | `src/model.ts`、`src/fake-model.ts`、`src/model-factory.ts` | `tests/model.test.ts` |
| 02 | 上下文与系统 Prompt | `src/system-prompt.ts`、`src/context.ts` | `tests/context.test.ts` |
| 03 | 最小 Agent Loop | `src/harness.ts`、`src/types.ts` | `tests/harness.test.ts` |
| 04 | 工具系统 | `src/tool.ts`、`src/tool-registry.ts`、`src/execute-tool.ts` | `tests/harness.test.ts` |
| 05 | 读懂仓库 | `src/workspace.ts`、`src/tools/read-file.ts`、`src/tools/search-text.ts` | `tests/harness.test.ts` |
| 06 | 修改代码 | `src/tools/apply-patch.ts`、`src/tool.ts`（`WriteLease`） | `tests/harness.test.ts` |
| 07 | 运行验证 | `src/tools/run-command.ts`、`src/completion.ts` | `tests/harness.test.ts`、`tests/agent-loop.test.ts` |
| 08 | 任务与状态 | `src/types.ts`、`src/state.ts` | `tests/state.test.ts` |
| 09 | 权限与安全 | `src/policy.ts`、`src/execute-tool.ts`、`src/index.ts` | `tests/harness.test.ts`、`tests/cli.test.ts` |
| 10 | 任务分解与规划 | `src/plan.ts`、`src/planner.ts` | `tests/plan.test.ts` |
| 11 | 用户澄清与中途转向 | `src/interaction.ts`、`src/model.ts`（`userInputRequest`） | `tests/interaction.test.ts` |
| 12 | Skills 渐进式加载 | `src/skill-catalog.ts`、`src/skill-runtime.ts`、`src/skill-tools.ts`、`skills/` | `tests/skills.test.ts` |
| 13 | 可观测性与评测 | `src/trace.ts`、`src/eval.ts`、`evals/cases.jsonl` | `tests/eval.test.ts` |
| 14 | 实现 Agent Loop | `src/agent-loop.ts` | `tests/agent-loop.test.ts` |
| 15 | 上下文压缩 | `src/compaction.ts`、`src/checkpoint.ts` | `tests/compaction.test.ts` |
| 16 | 长程任务恢复 | `src/run-store.ts`、`src/recovery.ts` | `tests/recovery.test.ts` |
| 17 | 综合 Capstone | `src/capstone.ts`、`evals/capstone.jsonl` | `tests/capstone.test.ts` |

`tests/support.ts` 是共享的离线 fixture 工具（临时目录、可脚本化 Planner、固定工具），
它不是测试文件，也不会被 Vitest 收集。

## 关键不变量

这些是教程 Checkpoint 点名、并且在测试里逐条断言的失败路径：

- 非法状态转换、空停止原因、终态恢复一律抛错（`src/state.ts`）。
- Plan 的空计划、重复 ID、未知依赖、依赖环被拒绝；未完成依赖的 Step 不能启动；
  同一时刻只能有一个 `in_progress`；没有 evidence 不能完成 Step（`src/plan.ts`）。
- 重规划只在 ID 与语义契约都不变时继承 completed/passed（`src/plan.ts`）。
- 工作区路径逃逸、符号链接逃逸、越界写入被拒绝（`src/workspace.ts`）。
- 未列入 `allowedArgv` 的命令被拒绝；允许的命令在人工批准前不会启动进程；
  批准凭证一次性、绑定 `actionDigest`、目标变化后失效（`src/policy.ts`）。
- 补丁带 SHA-256 前置条件；`file_changed`、`edit_not_unique` 都会失败且不改动文件（`src/tools/apply-patch.ts`）。
- 完成门禁绑定 `mutationRevision` + 当前文件 hash + criterion ID；旧验证记录立即失效（`src/completion.ts`）。
- 模型提前宣布完成会被打回，并以 `harness_feedback` 重新 Assemble（`src/agent-loop.ts`）。
- Planner 返回本轮 observation 之外的证据会被拒绝（`src/plan.ts`）。
- 压缩漏项、引用不存在的事件、篡改 Goal/验收条件/变更文件都会被拒绝（`src/compaction.ts`）。
- 崩溃恢复：事件日志 + 原子 checkpoint + lease fencing；in-flight 工具只对账不重跑，
  副作用总计只发生一次；恢复不重置预算（`src/run-store.ts`、`src/recovery.ts`）。

## 已知的降级处理

- **Loop 与持久化没有逐事件接线**。`RunStore` 提供了 append-only 事件日志、原子 checkpoint 与
  lease fencing，并且 `resumeAgentRun` 会在恢复结束时写入 checkpoint；但运行中的 `runAgentLoop`
  没有把每一轮事件实时写进 store（教程把它留作"按边界 flush"的部署选择）。
  `tests/recovery.test.ts` 用手写 fixture 覆盖崩溃点，而不是驱动完整 Loop 崩溃。
- **进程隔离未实现**。`PolicyContext.network` 只是策略输入，不会真的给子进程禁网；
  教程明确要求执行不可信仓库代码时必须依赖容器或 OS sandbox，fixture 不做这件事。
- **`providerCursor` 兼容性检查是可选钩子**。`ModelDriver.canResume` 存在时会用它；
  真实部署还需要核对 Provider、模型与保留策略。
- **`src/index.ts` 的 `main` 不连接真实模型**。离线 fixture 没有 `openai` 依赖，
  也没有 `tsx`，因此真实驱动必须由嵌入方注入。
