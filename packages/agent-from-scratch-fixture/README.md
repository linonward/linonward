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
可执行入口是 `scripts/agent.ts`（`pnpm agent`）：它装配真实 DeepSeek Responses 驱动
（见"接入真实模型"）；同时 `createAgentCliRuntime` 仍然保留，嵌入方可以自行注入其它
`ModelDriver` / `Planner` / `ToolRegistry`（`tests/agent-cli.test.ts` 用替身驱动同一条链路）。

## 命令行入口

`package.json` 的 `agent` 脚本是唯一的可执行入口，`src/agent-cli.ts` 负责 flag 解析与装配：

```sh
cd packages/agent-from-scratch-fixture
pnpm agent run "读取 package.json，告诉我这个项目用哪个包管理器，并列出 scripts 里的命令" --cwd /tmp/demo --allow node --version
pnpm agent --verbose run "读取 package.json，简述这个项目的用途" --cwd /tmp/demo
pnpm agent --verbose --log run.jsonl run "读取 package.json" --cwd /tmp/demo
pnpm agent resume <run-id>
pnpm agent answer <run-id> <request-id> "用 pnpm"
```

脚本本体是 `node --env-file-if-exists=.env --import tsx scripts/agent.ts`：

- `--env-file-if-exists=.env`：`.env` 存在时由 Node 24 原生加载，不存在也不报错，
  因此不需要 `dotenv` 依赖；`.env` 已被仓库根 `.gitignore` 忽略。
- `--import tsx`：直接执行 `.ts` 入口。`tsx` 是唯一为此新增的 devDependency。
- 缺 `DEEPSEEK_API_KEY` 时不会发起任何请求，而是打印包含 `.env.example` 指引的错误并以
  退出码 `2` 结束（错误信息**不会回显 key 值**）。

### flags

| flag | 作用 |
| --- | --- |
| `--cwd <dir>` | 任务工作区根，默认当前目录。策略的 `cwd` / `realWorkspaceRoot` 都用它 |
| `--allow <command> [args...]` | 把**一条完整 argv** 加入 `run_command` 白名单，可重复。`--allow node --version` 只放行 `node --version` 这条精确 argv；收集会持续到下一个已识别的 CLI flag |
| `--require-sandbox` | 显式要求隔离：没有可用沙箱时 `run_command` 拒绝执行而不是无隔离运行 |
| `--approve-allowed` | 对**策略已经放行**的命令自动批准（白名单仍是硬边界；默认会停在 `approval_required`） |
| `--max-cost-usd <amount>` | 花费上限（美元，按价目表估算）。越过即停（`max_cost`）；设了上限却算不出成本时同样停下 |
| `--max-wall-ms <ms>` | 墙钟上限：越过即停（`max_wall_ms`） |
| `--max-steps <n>` | 模型步数上限，默认 `16` |
| `--max-tool-calls <n>` | 工具调用上限，默认 `32` |
| `--verbose` | 在 stderr 上追加**完整运行日志**：模型的真实输入与输出（system prompt 全文、每条输入消息全文、`finalText` 全文、`toolCalls` 的 `argumentsJson` 全文）、完整工具链（每个调用的 `argsJson` 与 observation `output` 全文、`ok` / `effect` / `errorCode` 与策略决定），以及既有的每个 Loop 事件一行（`[event] ...`）与运行结束汇总（`[summary] ...`）。默认关闭，开启前后都不改变 stdout 上的最终答案与退出码；放在子命令前或后都可以 |
| `--log <path>` | 把 `--verbose` 的同一条日志额外以 **JSONL** 追加写入文件（每行一个 JSON 对象，带 `kind` / `at` / `durationMs`），文件不存在则创建。只在 `--verbose` 打开时生效；`--verbose` 关闭时不会创建任何日志文件 |
| `--no-truncate` | 关闭单条内容默认 `20000` 字符的上限；打开时会在 stderr 顶部打印一行警告。只在 `--verbose` 打开时生效 |
| `--no-repeat-guard` | 关闭"连续相同工具调用"护栏（**默认开启**，属于 Harness 约束）。第 `2` 次 `name + 规范化 args` 完全相同的调用会追加一条 `harness_feedback`（priority `100`）提醒模型；第 `3` 次不再执行，直接返回结构化 `repeated_tool_call` observation 并记为失败尝试。同名但参数不同的正常重试不受影响 |

`--verbose` 的日志分为两类：

- **完整日志**（每条带 ISO 时间戳与耗时）：`[run] ...` 运行元信息（task / cwd / budgets /
  `allowedArgv` / `requireSandbox` / 模型 id，**不含密钥**）、`[model] request ...` 与
  `[model] response ...`（第几轮 + `start` / `continue`）、`[tool] call ...` 与
  `[tool] result ...`（参数与结果全文，失败时带 `error=<code>` 与截断后的 `reason=`），
  以及每次模型调用一行 `[usage] ...`。模型 I/O 由 `createJournalModelDriver` 装饰真实
  （或注入的假）`ModelDriver` 采集；工具链由 Loop 的 `onToolCall` 钩子采集。
- **有界摘要**（保持既有能力不变）：`[event] ...`、`[tool] <name> callId=... chars=... preview=...`
  与 `[summary] ...`，单条最多 `200` 字符（失败原因 `120` 字符）、工具观测最多列 `20` 条（更早的
  折叠成 `[verbose] omitted N earlier observation(s)`）。

完整日志里的单条内容默认最多 `20000` 字符，超出写 `…truncated(原长度 N)`；`--no-truncate`
才会写全文。`--verbose` 关闭时连 journal 都不会创建（默认路径零额外开销、stderr 逐字节不变）。
stdout 永远只有最终答案，因此 `pnpm agent --verbose --log run.jsonl run "..." > answer.txt`
依然可用。

### 用量与成本（token / 缓存命中 / 耗时 / 估算成本）

`--verbose`（含 `--log`）会输出三类用量信息，**默认路径一行都不多**：

```text
[usage] step=1 phase=start in=1234 out=256 cached=1024 durationMs=0 model=deepseek-v4-flash cost=$0.000445
[summary] usage modelCalls=2 toolCalls=1 in=3282 out=320 cached=2560 wallMs=10 cost=$0.000776
[usage] run: modelCalls=2 toolCalls=1 in=3282 out=320 cached=2560 wallMs=10 cost=$0.000776 (prices asOf=2026-08-23, source=https://api-docs.deepseek.com/quick_start/pricing (peak rates; off-peak is half); cache hits billed separately)
```

- **每次模型调用一行** `[usage]`：token、缓存命中、该次调用耗时、模型 id 与按次估算成本。
- **运行结束一行** `[usage] run:`：调用计数、token 合计、整轮墙钟时间（`wallMs`）、估算成本，
  以及价目表的 `asOf` / `source` 与计价口径。
- **`[summary] usage`**：有界汇总里的同一组数字。

同一批记录同时写进 `--log` 的 JSONL（`kind: "usage"`，`scope: "model"` / `"run"`）。
**未知就是 `unknown`**：provider 没返回 `usage`（或没返回某个字段）时，`addUsage` 会让合计保持
未知，输出 `in=unknown`；JSONL 里该字段直接**缺失**（不写 0、不写 null）。成本同理：模型不在价目表
里、或 token 未知时显示 `cost=unknown`，**绝不显示 `$0.000000` 冒充免费**。

用量累加在 `AgentState.usage`（`RunUsage`）上，而**不是** `AgentResult`：

- 它随检查点一起持久化（`DurableAgentState.usage` → `toDurableState` / `fromDurableState`），
  因此 `answer` / `resume` 之后是**接着涨**，而不是从 0 重来（`tests/agent-cli.test.ts` 有一条
  run → answer 的断言：`modelCalls=1 in=100` → `modelCalls=3 in=600`）。
- 旧检查点没有这个字段时按"已知的 0"补齐（`emptyUsage()`），老 run 仍然可以恢复。
- 已知的降级：**规划器（`createModelPlanner`）的 token 不计入**。规划调用发生在 `Planner`
  接口背后，本 fixture 还没有把它的 usage 汇入 Loop 的累加器；`createResponsesModel` 提供了
  `onUsage` 回调，接入方可以自行收集。

### 估算成本怎么算（版本化、可配置、可追溯）

`src/pricing.ts` 负责成本估算：

| 变量 | 说明 |
| --- | --- |
| `DEEPSEEK_PRICE_TABLE_JSON` | 内联 JSON 价目表，**优先级最高**（`{"asOf":"...","models":{...}}`） |
| `DEEPSEEK_PRICE_TABLE` | 指向 JSON 价目表文件；两个都设置时内联 JSON 生效 |

两个都为空时用内置表。**解析失败一律报可读错误**（含字段路径）而不是静默退回内置表——
`DEEPSEEK_PRICE_TABLE_JSON='{not json'` 会让 CLI 在装配期就失败，避免"我以为按内部价算的"。

内置表来自官方 "Models & Pricing"（文档镜像快照 `asOf=2026-08-23`，
`source=https://api-docs.deepseek.com/quick_start/pricing`），只覆盖表格里的三个模型
（`deepseek-v4-flash` / `deepseek-v4-pro` / `deepseek-v4-flash-vision-exp`）。官方对每个价格都给了
peak / off-peak 两档（off-peak 恰好是 peak 的一半），内置表取 **peak 作为上界**，并把口径写进
`source`：它是量级估算，不是账单。

计价口径：`input_tokens` 是总量、`cached_tokens` 是它的子集，所以表里有独立缓存价时只对未命中的
输入按 cache miss 价计费；表里没有缓存价时缓存部分并入 input 价（`describeCostBasis` 会在
`[usage] run:` 行注明是哪种）。`cached_tokens` 未知时按 cache miss 计（上界），同样有注明。

### `plan_revised` 说清"为什么改、改了什么"

反复修订计划曾经只打印一行 `reason`，看不出计划到底变了什么、是谁触发的。现在每次修订都带**有界**
详情（`PlanRevisedDetail`）：

```text
[event] plan_revised version=2 reason=failed_assumption added=step-2 removed=(none) renamed=step-1 dependsChanged=0 failed=boom:tool_error
```

- **计划差异**：新增 / 删除 / 标题变化的步骤 id、依赖变化的步骤数。每类最多列 `10` 条，超出写
  `…(+N)`（每条 id 同样走 `200` 字符截断）；依赖按集合比较，顺序变化不算"改了什么"。
- **触发证据**：最近失败的工具（名字 + `error=<code>`），最多 `3` 条，超出写 `…(+N)`。
- **JSONL**：`--log` 里多出一条 `kind: "plan_revised"` 记录，`detail` 字段携带同一份结构化差异
  （`addedSteps` / `removedSteps` / `renamedSteps` / `dependencyChanges` / `recentFailures` …）。
- **默认路径不变**：canonicalJson 事件流仍然只有 `type` / `version` / `reason`；`detail` 只出现在
  `--verbose` 的 `[event]` 行与 `--log` 的 JSONL 里（`tests/agent-cli.test.ts` 逐字节断言）。

工具失败的 `[tool]` 行也补齐了原因：`ok=false` 之外还有 `error=<code>`（来自 observation 的
`error` 字段）与截断到 `120` 字符的 `reason=<message>`；JSONL 的 `kind: "tool_result"` 记录里是
`error` / `reason` 两个字段。

### 预算耗尽说清"卡在哪、还差什么"

`max_steps` / `max_tool_calls` 停止时，Loop 会先登记一条**有界**的 `budget_exhausted` 运行时事件
（`reason` / `budget` / `usage`（含 `formatCostUsd` 后的 `cost`）/ 活动步骤 / `pendingSteps` /
最近 ≤`5` 次工具调用（带 `repeated`）/ `lastReplanReason`），`--verbose` 的汇总据此追加：

```text
[summary] stopped: max_steps (modelSteps=16/16, toolCalls=22/32)
[summary] stopped detail: active=step-3(status=in_progress); last tools=read_file(ok), apply_patch(file_changed); repeated=apply_patch x2; pending=step-3, step-4(+1)
[summary] hint: 模型在重复同一个工具调用，考虑检查 observation 是否足以让它继续，或提高 --max-tool-calls / 换更强模型
```

`hint` 依事实生成：有重复调用时提示检查 observation / 提高 `--max-tool-calls`；否则若计划仍未完成，
提示提高 `--max-steps` 或拆分任务。`--log` 里多出一条 `kind: "budget_exhausted"` 记录，字段与事件
`detail` 一致；**默认路径仍然一行都不多**（`budget_exhausted` 只进内存事件日志，不改变 canonicalJson 事件流）。


> **日志可能含敏感内容**：完整日志记录模型 payload、工具参数与工具结果的**原文**，仓库文件内容、
> 命令输出等都会出现在 stderr 与 `--log` 文件里。`--log` 会把这些内容落盘，请自行选择安全路径并
> 及时清理。日志**绝不**记录环境变量或密钥，只记录模型 payload、工具参数与结果。

`run` 的持久化落在 `AGENT_STORE_ROOT`（默认 `<系统临时目录>/linonward-agent-runs`）下的
`LocalFileRunStore`：`resume` / `answer` 是独立进程，必须靠这个稳定路径找到同一个 run。
`--cwd` 只决定任务工作区，不影响存根位置。

### 退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | `completed`：最终答案已写到 stdout |
| `1` | `failed`：运行失败，或 `resume` / `answer` 不可执行（未知 run、未知 requestId、无有效检查点等） |
| `2` | `usage`：参数错误（未知 flag、缺值、非法数字、缺子命令）或缺少 `DEEPSEEK_API_KEY` |
| `3` | `waiting`：停在 `user_input_required` / `approval_required`，用 `answer` 继续 |
| `130` | `cancelled`：进程收到 `SIGINT` / `SIGTERM` |

每次 `run` / `resume` / `answer` 都会在结束时释放 run 的 lease，因此三条命令可以连续执行，
不需要等待 TTL 过期。

`answer` 按 requestId 分辨两条恢复路径：

| 情况 | 恢复方式 |
| --- | --- |
| **澄清**（`request_user_input`） | 把回答写进上下文（`applyUserAnswer`），状态回到 `running` |
| **审批**（策略 `ask`） | 在批准账本里放行那条请求（`grantApproval`），重放的同一调用消费一次性凭证后执行 |

批准凭证绑定"真正会被执行的东西"（`command` + `args` + cwd + 网络策略）：模型重放同一调用时
换个 `purpose` 说法不会让批准失效，但换成另一条命令就必须重新批准。

> **已知限制**：`agent answer` 只有在批准账本还活着时才能批准——CLI 每次调用都新建运行时，
> 账本在进程内，所以跨进程的 `agent answer` 依然答不了审批（澄清不受影响，因为它只读检查点）。
> 长驻进程（例如 `apps/agent-console`）每次运行持有一个账本，因此可以在其中批准。

## 接入真实模型（DeepSeek Responses API）

真实通路与它的 CLI 装配由五个模块组成，都只依赖 Node 24 内置 `fetch`，不引入任何新运行时依赖（`tsx` 只是开发期执行器）：

| 模块 | 职责 |
| --- | --- |
| `src/responses-http.ts` | `POST {baseUrl}/responses`、超时、429/5xx/网络错误的有界指数退避重试、把响应归一化成 `ResponsesResultLike`（从 `message.content[].output_text` 聚合 `output_text`），并提供 `resolveDeepSeekConfig` / `createResponsesModel` |
| `src/responses-stateless-driver.ts` | 无状态 `ModelDriver`：在客户端累积 `output` items，续轮重发完整历史 |
| `src/planner-model.ts` | 完整 `Planner`（`create` / `revise` / `evaluate`）：JSON 解析健壮化、证据用下标、`completed` 判据收紧、失败带错误有界重试、降级可见 |
| `src/run-task.ts` | `runRealTask`：把工具注册表、策略、trace、`LocalFileRunStore` + lease、时钟、Skills、压缩装配到 `runAgentLoop` 上 |
| `src/agent-cli.ts` | `pnpm agent` 的装配层：`parseAgentArgs` 解析 flags，`createDeepSeekAgentCli` 装配真实驱动 / 工具 / 沙箱 / 策略并返回 argv 处理器；全部依赖可注入替身 |
| `src/cli-journal.ts` | 完整运行日志：`createJournal`（stderr 可读行 + 可选 JSONL 双写、统一时间戳与截断）、`createJournalModelDriver`（装饰 `ModelDriver` 采集真实模型 I/O 与每次调用的 usage）与 `createJournalToolHook`（接 Loop 的 `onToolCall`） |
| `src/pricing.ts` | 版本化价目表与成本估算：`estimateCostUsd`（未知即 `undefined`，绝不返回 0）、`describeCostBasis`（缓存口径注明）、`BUILTIN_PRICE_TABLE` 与 `DEEPSEEK_PRICE_TABLE(_JSON)` 覆盖 |

### 环境变量

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `DEEPSEEK_API_KEY` | 是 | — | 唯一的密钥来源。代码不会读取内置密钥，错误信息也**不会回显 key 值** |
| `DEEPSEEK_BASE_URL` | 否 | `https://api.deepseek.com/v1` | 兼容网关或代理地址 |
| `DEEPSEEK_MODEL` | 否 | `deepseek-v4-flash` | **循环模型**：多轮工具调用用它。也可用 `deepseek-v4-pro`，或从 `GET /v1/models` 发现 |
| `DEEPSEEK_PLANNER_MODEL` | 否 | 回落到 `DEEPSEEK_MODEL` | **规划模型**：只给模型版规划器用。规划只输出短 JSON，可以单独选更强的型号 |
| `DEEPSEEK_PRICE_TABLE` | 否 | 内置表 | 成本估算用的 JSON 价目表文件；见"估算成本怎么算" |
| `DEEPSEEK_PRICE_TABLE_JSON` | 否 | — | 内联 JSON 价目表，优先级高于 `DEEPSEEK_PRICE_TABLE`；解析失败**报错**而不是退回内置表 |

密钥只从进程环境变量读取：fixture 没有 `dotenv` 依赖；`pnpm agent` 通过
`node --env-file-if-exists=.env` 在 `.env` 存在时自动加载它，其它入口（例如 `vitest`）
不会自动加载，请在命令行显式传入。

### 运行真实 e2e

```sh
# 只跑真实端到端（会消耗 API 额度）。规划模型可以单独指定：
# 循环用 DEEPSEEK_MODEL，规划用 DEEPSEEK_PLANNER_MODEL（不设则回落到循环模型）。
DEEPSEEK_API_KEY=sk-... DEEPSEEK_PLANNER_MODEL=deepseek-v4-pro \
  pnpm turbo run test --filter=@linonward/agent-from-scratch-fixture --force -- deepseek

# 等价地直接进入包目录
cd packages/agent-from-scratch-fixture
DEEPSEEK_API_KEY=sk-... DEEPSEEK_PLANNER_MODEL=deepseek-v4-pro pnpm exec vitest run deepseek
```

`--force` 不是可选装饰：Turborepo 的任务哈希默认不包含 `DEEPSEEK_API_KEY`，
不加它可能直接命中"上一次无 key 时的 skipped"缓存，e2e 看起来通过其实根本没执行。

**默认路径仍然完全离线**：不设置 `DEEPSEEK_API_KEY` 时，`tests/deepseek-e2e.test.ts` 整体
`skipped`，其余测试、`typecheck`、`lint` 都不需要网络或密钥：

```sh
pnpm turbo run test typecheck lint --filter=@linonward/agent-from-scratch-fixture --force
# → Test Files 21 passed | 1 skipped (22)；Tests 242 passed | 5 skipped (247)
#   e2e 文件整体 skipped（缺 key），沙箱集成 2 例默认 skip；tsc --noEmit 与 eslint 零问题
```

### 模型版规划器的契约

`createModelPlanner` 把模型输出当作**候选**，在进入 Loop 之前做四件事：

1. **解析健壮化**：`extractJsonObject` 先直接 `JSON.parse`，失败则剥 ```json``` 围栏，
   再失败则取第一个大括号平衡的 `{...}` 片段（跟踪字符串状态，忽略字符串里的 `{}`），
   仍失败才抛错。`create` / `revise` / `evaluate` 三个调用点都走它。
2. **证据用下标**：`evaluate` 的输入里显式给出 `completionEvidence`（"完成该步骤需要什么证据"）
   与本轮 `observations`；模型只能通过 `evidenceIndexes`（0 基下标）引用观测原文。
   长观测无法被逐字回抄，字符串证据几乎总会被 `assertEvidenceComesFromObservations`
   判成"编造"，所以下标是唯一可靠通道。
3. **`completed` 的判据**：只要本轮 observations 已足以证明 `completionEvidence`，
   就必须 `completed: true` + 非空 `evidenceIndexes` + `replanReason: null`；
   `replanReason` 只在**计划本身失效**时给出，"步骤还在进行中 / 本轮证据还不足"不是理由。
   `completed: true` 但证据下标为空或全部越界时，规划器**降级为 `completed: false`**，
   并把可读原因放进 `PlanEvaluation.notes`，而不是静默通过。
4. **失败可重试**：`revise` / `evaluate` 的解析或校验失败最多重试 2 次，
   每次把上一次的错误 + "只输出 JSON" 作为追加消息再问一次（有界，不会无限重试）。

`evaluate` 还会收到当前计划的 `acceptanceCriteria`，并把 `passedCriteria` 过滤到只含真实存在的
id——计划外的 id 会让 `applyCriterionEvidence` 直接抛错并终止整个运行。

### 三条 e2e 的分工

| 用例 | 规划器 | 验证的东西 |
| --- | --- | --- |
| task 1（只读） | 确定性 `CompletingPlanner` | 真实模型驱动 + 工具 + 完成门禁这条链路 |
| task 2（写 + 验证） | 确定性 `patchAwarePlanner` | 真实补丁 + `ValidationRecord` 绑定 `mutationRevision` |
| task 3（只读，模型规划） | 真实模型规划器（`createDeepSeekTaskModels`，`create/revise/evaluate` 全真实） | 模型版规划器本身能否收敛到 `final_answer` |

前两条刻意用确定性规划器：把"模型是否愿意按 JSON 契约规划"这个变量排除掉，只测 Harness；
task 3 才把规划器换成真实模型，专门覆盖解析/证据/`completed` 判据这条契约。
三条都需要 `DEEPSEEK_API_KEY`；task 3 可用 `DEEPSEEK_PLANNER_MODEL` 指定独立规划模型。

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

## 进程隔离（可选沙箱）

策略里的 `PolicyContext.network: "disabled"` 只是**声明**：它让策略层拒绝网络/外部副作用工具，
但**不会**给已经放行的 `run_command` 子进程禁网。真正的 OS 级边界来自 `src/sandbox.ts`：

| Sandbox | `id` | 提供的保证 | 实现 |
| --- | --- | --- | --- |
| `macOsSeatbeltSandbox` | `macos-seatbelt` | `network-isolation`、`filesystem-write-confinement` | `sandbox-exec -p <profile>`：`network: "disabled"` 时 `(deny network*)`；`(deny file-write*)` 后只放行工作区与系统临时目录；读取不受限；路径按 SBPL 字面量转义（含空格/引号/换行） |
| `linuxBubblewrapSandbox` | `linux-bubblewrap` | 同上 | `bwrap --ro-bind / /` + `--bind <root> <root>`；`network: "disabled"` 时加 `--unshare-net`；`--chdir` 指向真实 cwd；没有 `bwrap` 时 `isAvailable()` 为 `false` |
| `noSandbox` | `none` | 无（`guarantees: []`） | 原样返回 argv。只适用于**可信任务**（例如仓库自己的测试），不提供任何隔离 |

- `detectSandbox()` 按平台选实现（darwin → seatbelt，linux → bubblewrap，其它 → `noSandbox`），
  但**不探测可用性**；`isAvailable()` 由调用方 `await`。
- `runRealTask` 默认 `sandbox: detectSandbox()`、`requireSandbox: false`。注入 `id !== "none"` 的沙箱
  本身就表示"要隔离"：不可用时 `run_command` 拒绝执行。未注入沙箱或注入 `noSandbox` 且
  `requireSandbox: false` 时，行为与接线前完全一致。
- 无人值守地执行**不可信仓库代码**时应当打开 `requireSandbox: true`：此时未注入沙箱、`noSandbox`、
  平台沙箱不可用都会拒绝执行。`src/policy.ts` 的 `network` 因此只是策略输入，不是隔离。
- `buildSeatbeltProfile(policy)` 与 `buildBubblewrapArgs(input, policy)` 是纯函数，
  可以离线断言 profile 文本与 argv（`tests/sandbox.test.ts`、`tests/harness.test.ts`）。
- 真实平台集成默认 skipped；需要时用
  `SANDBOX_INTEGRATION=1 pnpm exec vitest run sandbox`（CI 没有 `bwrap`，macOS 上 `sandbox-exec`
  也可能被外层沙箱拦住）。

**真隔离 vs 仍需容器**：seatbelt 与 bubblewrap 提供的 `network-isolation`、
`filesystem-write-confinement` 是内核强制的（网络系统调用被拒 / 只有工作区可写），
但它们**共享宿主机内核**，不做镜像或虚拟化级隔离，也不限制 CPU、内存与磁盘配额，
macOS 侧仍放行系统临时目录、Linux 侧仍是整机只读可见。执行真正不可信的仓库代码时，
容器或专用 VM 仍是主边界，这个模块是"没有容器时的进程级补充"。

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
| `src/planner-model.ts` | `tests/planner-model.test.ts` | `extractJsonObject` 三级解析、create/revise/evaluate 的解析与校验、带错误的有界重试、编造证据被丢弃、`completed=true` 但证据为空时降级为 `false` 并给出 notes、计划外 criterion id 被忽略 |
| `src/run-task.ts` | `tests/run-task.test.ts` | 离线装配：工具 + 持久化 + trace + lease 释放；伪造证据被 Loop 拒绝 |
| `src/pricing.ts` | `tests/pricing.test.ts` | 内置表的 `asOf` / `source`、缓存单独计价 vs 并入 input 价、未知模型 / 未知 token → `undefined`（绝不 0）、`DEEPSEEK_PRICE_TABLE(_JSON)` 覆盖与解析失败报错 |
| `src/agent-cli.ts` | `tests/agent-cli.test.ts` | 离线：三种命令与全部 flag 的解析、`--allow` 重复收集、非法输入报错含 `AGENT_USAGE`、`FakeModelDriver` 驱动 `run` / `answer` / 恢复、缺 key 指引进 `.env.example`；`[usage]` 透传与 `unknown`、成本覆盖、`plan_revised` 详情与默认路径逐字节不变 |
| 端到端 | `tests/deepseek-e2e.test.ts` | 真实调用，`describe.skipIf(!process.env.DEEPSEEK_API_KEY)` 门控；两条确定性规划器 + 一条真实模型规划器 |

## 关键不变量

这些是教程 Checkpoint 点名、并且在测试里逐条断言的失败路径：

- 非法状态转换、空停止原因、终态恢复一律抛错（`src/state.ts`）。
- Plan 的空计划、重复 ID、未知依赖、依赖环被拒绝；未完成依赖的 Step 不能启动；
  同一时刻只能有一个 `in_progress`；没有 evidence 不能完成 Step（`src/plan.ts`）。
- 重规划只在 ID 与语义契约都不变时继承 completed/passed（`src/plan.ts`）。
- 工作区路径逃逸、符号链接逃逸、越界写入被拒绝（`src/workspace.ts`）。
- 未列入 `allowedArgv` 的命令被拒绝；允许的命令在人工批准前不会启动进程；
  批准凭证一次性、绑定 `actionDigest`、目标变化后失效（`src/policy.ts`）。
- 需要隔离时"要么真隔离、要么拒绝"：注入的沙箱不可用，或沙箱不提供策略要求的
  `network-isolation` 时，`run_command` 在 `spawn` 之前就以 `sandbox_unavailable` /
  `sandbox_network_isolation_unsupported` 失败（`src/sandbox.ts`、`src/tools/run-command.ts`）。
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
- **进程隔离是可选注入，默认仍是 `noSandbox`**。`PolicyContext.network` 只是策略**声明**，
  不会给已放行的 `run_command` 子进程禁网；真正禁止网络、把写入限制在工作区内由
  `src/sandbox.ts` 的可注入实现提供（见"进程隔离（可选沙箱）"）。门禁语义是**失败即拒绝**：
  需要隔离而沙箱不可用、或沙箱无法满足 `network: "disabled"` 时，`run_command` 抛
  `sandbox_unavailable` / `sandbox_network_isolation_unsupported`，**绝不**静默退回无隔离执行。
  默认 `detectSandbox()` 在 macOS/Linux 选真沙箱，其它平台退回 `noSandbox`；执行不可信仓库代码
  仍需容器或 OS sandbox，并应把 `requireSandbox` 打开。
- **`providerCursor` 兼容性检查是可选钩子**。`ModelDriver.canResume` 存在时会用它；
  真实部署还需要核对 Provider、模型与保留策略。
- **CLI 入口与运行时装配是两层**。`pnpm agent`（`scripts/agent.ts`）现在会装配真实的
  DeepSeek Responses 驱动：`src/agent-cli.ts` 用 `resolveDeepSeekConfig` +
  `createResponsesHttpClient` 装配循环驱动（`DEEPSEEK_MODEL`）与模型版规划器
  （`DEEPSEEK_PLANNER_MODEL`），工具走 `createRealTaskRegistry`，沙箱走 `detectSandbox`，
  因此真实通路不再需要嵌入方注入。与此同时 `createAgentCliRuntime` 与
  `src/index.ts` 的 `parseCliArgs` / `runCli` 仍然保留：调用方可以注入其它
  `ModelDriver` / `Planner` / `ToolRegistry`（`tests/agent-cli.test.ts` 用
  `FakeModelDriver` 驱动 `run` / `resume` / `answer` 三条命令，全程离线）。
  真实通路另外提供 `src/run-task.ts` 的 `runRealTask`——它是装配函数，不是 CLI 子命令。
- **预算有两类**：`--max-steps` / `--max-tool-calls` 管"做了多少次"，`--max-cost-usd` /
  `--max-wall-ms` 管"花了多少、跑了多久"。后者在每次模型调用后判定，因此**当轮的工具不会
  再被派发**；一次调用本身可能把花费推过上限，体现在诊断里就是 `spent` 略高于 `maxCostUsd`。
- **真实运行默认不自动批准命令**。`runRealTask` 只有在显式打开
  `autoApproveAllowedCommands` 时才会自动批准策略放行的 `run_command`（e2e 测试这么用）；
  默认仍会停在 `approval_required`。无论哪种情况，`allowedArgv` 都是硬边界。
- **e2e 依赖真实模型行为**。三条 e2e 用例的断言都收敛在**确定性副作用**上（文件内容、
  `changedFiles`、绑定 `mutationRevision` 的 `ValidationRecord`、`stopReason`），
  但模型是否愿意按提示调用工具仍存在不确定性；失败时先用 `console.log` 打印的
  事件序列与 answers 判断是"模型没照做"还是"harness 出错"。
- **取消会打断正在飞行中的模型调用**。`createResponsesHttpClient` 接受外部 `AbortSignal`：
  没有它，"中止"只能等下一次循环检查，用户要干等一次 60 秒超时。CLI 侧目前仍以
  `SIGINT` + 工具/HTTP 超时为准（客户端在装配期创建，尚未绑定每次调用的信号）。
- **`providerCursor` 真实通路未实现**。`createStatelessResponsesDriver` 不提供
  `canResume`，因为 DeepSeek 无状态：跨进程恢复只能靠客户端重发历史，
  当前 fixture 的恢复链路（`resumeAgentRun`）仍然面向 OpenAI 风格的 cursor。
