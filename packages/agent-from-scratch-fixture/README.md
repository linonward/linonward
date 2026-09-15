# @linonward/agent-from-scratch-fixture

`apps/tutorial` 中文教程主线 18 章逐步搭出来的 `agent-from-scratch` 项目的**可执行参考实现**。

教程每一章都在同一个项目上增量修改，但教程本身没有附带一个"把每一章增量都应用上去"的可执行工程。
这个包就是那个缺口：它把主线所有章节的代码块合并成一份可以 `typecheck`、可以 `test`、可以 `lint`
的离线工程，用来验证教程给出的每个契约真的能编译、能运行、能测。

## 不做什么

- **默认不调用真实模型**：默认路径不访问网络、不读取任何 API Key，模型边界统一是
  `Model` / `ModelDriver`，离线路径由 `FakeModel` / `FakeModelDriver` 满足。
  真实通路是**显式 opt-in**：只有提供 `DEEPSEEK_API_KEY` 时才走 DeepSeek Responses API（见下）。
- 不依赖 `openai` 包：`ResponsesClientLike` 是一个结构类型，真实项目里由 SDK 满足它，
  fixture 里由测试注入结构替身；真实通路直接用 Node 内置 `fetch` 实现 HTTP 客户端。
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
需要真实模型时用下面这条 opt-in 通路，它默认仍然完全离线。

## 接入真实模型（DeepSeek Responses API）

真实通路由四个模块组成，都只依赖 Node 24 内置 `fetch`，不引入任何新依赖：

| 模块 | 职责 |
| --- | --- |
| `src/responses-http.ts` | `POST {baseUrl}/responses`、超时、429/5xx/网络错误的有界指数退避重试、把响应归一化成 `ResponsesResultLike`（从 `message.content[].output_text` 聚合 `output_text`），并提供 `resolveDeepSeekConfig` / `createResponsesModel` |
| `src/responses-stateless-driver.ts` | 无状态 `ModelDriver`：在客户端累积 `output` items，续轮重发完整历史 |
| `src/planner-model.ts` | 完整 `Planner`（`create` / `revise` / `evaluate`），只解析结构化 JSON，并把"编造的证据"过滤掉 |
| `src/run-task.ts` | `runRealTask`：把工具注册表、策略、trace、`LocalFileRunStore` + lease、时钟、Skills、压缩装配到 `runAgentLoop` 上 |

### 环境变量

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `DEEPSEEK_API_KEY` | 是 | — | 唯一的密钥来源。代码不会读取内置密钥，错误信息也**不会回显 key 值** |
| `DEEPSEEK_BASE_URL` | 否 | `https://api.deepseek.com/v1` | 兼容网关或代理地址 |
| `DEEPSEEK_MODEL` | 否 | `deepseek-v4-flash` | 也可用 `deepseek-v4-pro`，或从 `GET /v1/models` 发现 |

密钥只从进程环境变量读取：fixture 没有 `dotenv` 依赖，也没有 `tsx`，
`.env` 文件不会被自动加载，请在命令行显式传入。

### 运行真实 e2e

```sh
# 只跑真实端到端（会消耗 API 额度）
DEEPSEEK_API_KEY=sk-... pnpm turbo run test --filter=@linonward/agent-from-scratch-fixture --force -- deepseek

# 等价地直接进入包目录
cd packages/agent-from-scratch-fixture
DEEPSEEK_API_KEY=sk-... pnpm exec vitest run deepseek
```

`--force` 不是可选装饰：Turborepo 的任务哈希默认不包含 `DEEPSEEK_API_KEY`，
不加它可能直接命中"上一次无 key 时的 skipped"缓存，e2e 看起来通过其实根本没执行。

**默认路径仍然完全离线**：不设置 `DEEPSEEK_API_KEY` 时，`tests/deepseek-e2e.test.ts` 整体
`skipped`，其余测试、`typecheck`、`lint` 都不需要网络或密钥：

```sh
pnpm turbo run test typecheck lint --filter=@linonward/agent-from-scratch-fixture --force
# → Test Files 17 passed | 1 skipped (18)；Tests 140 passed | 2 skipped (142)
#   e2e 文件整体 skipped，tsc --noEmit 与 eslint 零问题
```

### 无状态注意事项

DeepSeek 的 Responses API 是**无状态**的：`previous_response_id`、`conversation`、`store`
都不支持，请求里带上也会被**静默忽略**（不报错）。因此：

- 多轮历史必须由客户端重发。`createStatelessResponsesDriver` 会累积每次响应的 `output`
  items（含 `function_call`），续轮发送 `[...累积的 output, ...本轮的 function_call_output, ...新上下文]`。
  `function_call` 是后续 `function_call_output.call_id` 的唯一配对锚点，绝不能丢。
- 发送前会剥掉 `strict`：DeepSeek 的 `tools` 只接受扁平的
  `{type:"function", name, description, parameters}`，`strict` 未见文档支持。
- 不支持 `truncation`：超出上下文窗口会直接返回 `400`（带状态码与响应体抛出），不会截断。
- 需要历史压缩时由调用方自己接线；`runRealTask` 默认给了一个大到不会触发的窗口，
  真被触发会显式报错而不是产出"差不多"的摘要。

既有 OpenAI 版本的 `createOpenAIModelDriver` 保持原样（它仍然发送 `previous_response_id`），
两条通路互不影响。

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

真实模型通路（默认离线，带 key 才跑 e2e）：

| 模块 | 测试文件 | 覆盖 |
| --- | --- | --- |
| `src/responses-http.ts` | `tests/responses-http.test.ts` | URL/方法/认证头/请求体、`output_text` 聚合、429 重试、400 不重试并带状态码、缺 key 报错不回显 key |
| `src/responses-stateless-driver.ts` | `tests/responses-stateless-driver.test.ts` | 首轮无 `previous_response_id`、续轮按序重发 `function_call` + `function_call_output` + 新上下文、`tools` 无 `strict` |
| `src/planner-model.ts` | `tests/planner-model.test.ts` | create/revise/evaluate 的解析、编造证据被丢弃、非法 JSON 报错 |
| `src/run-task.ts` | `tests/run-task.test.ts` | 离线装配：工具 + 持久化 + trace + lease 释放；伪造证据被 Loop 拒绝 |
| 端到端 | `tests/deepseek-e2e.test.ts` | 真实调用，`describe.skipIf(!process.env.DEEPSEEK_API_KEY)` 门控 |

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
- 压缩已接入 Loop：每轮 Assemble 前按阈值 + 安全边界触发，压缩后上下文用
  "快照 + rawTail"表达；连续两次校验失败以 `compaction_failed` 停止，期间绝不换用"差不多"的摘要
  （`src/agent-loop.ts`、`src/compaction.ts`）。
- 崩溃恢复：事件日志 + 原子 checkpoint + lease fencing；in-flight 工具只对账不重跑，
  副作用总计只发生一次；恢复不重置预算（`src/run-store.ts`、`src/recovery.ts`）。
- Loop 按边界把事件 flush 进 `RunStore` 并在每个安全边界写检查点；store 写入失败（含 lease 被抢占）
  一律安全停止为 `interrupted`，不再写 store、也不让进程崩溃（`src/agent-loop.ts`）。

## 已知的降级处理

- **事件日志是"按边界 flush"，不是逐条同步落盘**。Loop 在每个安全边界（初始计划之后、每个工具批次之后、
  压缩之后、每次停止之前）写检查点，并按边界把 durable 事件 append 进 store；`step_started`、
  `tool_batch_started` 这类只属于运行时的事件留在内存日志（检查点里），不写进 store 的
  `DurableEvent` 联合。因此崩溃最多丢失"最后一个边界之后"的进度，重放从该检查点接续。
- **进程隔离未实现**。`PolicyContext.network` 只是策略输入，不会真的给子进程禁网；
  教程明确要求执行不可信仓库代码时必须依赖容器或 OS sandbox，fixture 不做这件事。
- **`providerCursor` 兼容性检查是可选钩子**。`ModelDriver.canResume` 存在时会用它；
  真实部署还需要核对 Provider、模型与保留策略。
- **`src/index.ts` 的 `main` 不连接真实模型**。离线 fixture 没有 `openai` 依赖，
  也没有 `tsx`，因此真实驱动必须由嵌入方注入。真实通路是 `src/run-task.ts` 的
  `runRealTask`：它是装配函数，不是新的 CLI 子命令；CLI 的 `run` / `resume` / `answer`
  仍然由调用方注入 `ModelDriver` / `Planner` / `ToolRegistry`。
- **真实运行默认不自动批准命令**。`runRealTask` 只有在显式打开
  `autoApproveAllowedCommands` 时才会自动批准策略放行的 `run_command`（e2e 测试这么用）；
  默认仍会停在 `approval_required`。无论哪种情况，`allowedArgv` 都是硬边界。
- **e2e 依赖真实模型行为**。两个 e2e 用例的断言都收敛在**确定性副作用**上（文件内容、
  `changedFiles`、绑定 `mutationRevision` 的 `ValidationRecord`、`stopReason`），
  但模型是否愿意按提示调用工具仍存在不确定性；失败时先用 `console.log` 打印的
  事件序列与 answers 判断是"模型没照做"还是"harness 出错"。
- **`providerCursor` 真实通路未实现**。`createStatelessResponsesDriver` 不提供
  `canResume`，因为 DeepSeek 无状态：跨进程恢复只能靠客户端重发历史，
  当前 fixture 的恢复链路（`resumeAgentRun`）仍然面向 OpenAI 风格的 cursor。
