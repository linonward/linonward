# @linonward/agent-console

把 `packages/agent-from-scratch-fixture` 的**一次真实运行**实时呈现出来的本地 Web 界面——
包括模型的**思维链**（`reasoning` items 的 `content[].text`，分片类型 `reasoning_text`）。

界面本身完全离线：真实模型请求只发生在本地 API 服务进程里，密钥只在那个进程的
`process.env` / `.env` 中读取，既不会渲染到页面，也不会写进任何响应或日志。

## 启动（Vite + 本地 API）

```sh
# 一次性拉起 Vite(5173) 与 API(8787)
pnpm --filter @linonward/agent-console dev

# 或者分开跑
pnpm --filter @linonward/agent-console dev:api   # http://127.0.0.1:8787
pnpm --filter @linonward/agent-console dev:web   # http://127.0.0.1:5173
```

打开 <http://127.0.0.1:5173>。前端只发相对路径的 `/api/...`，开发时由 Vite 代理到
`http://127.0.0.1:8787`。

地址栏里的 `?run=<runId>` 就是当前这次运行：刷新页面会重新接上它，链接可以直接分享给
自己（同一个本地服务）。`清空并新建` 只去掉这个参数，不动磁盘上的运行。

生产构建：

```sh
pnpm --filter @linonward/agent-console build   # → apps/agent-console/dist
```

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `DEEPSEEK_API_KEY` | **必需**。只被 API 服务读取；未配置时 `POST /api/run` 返回 4xx 可读错误。 |
| `DEEPSEEK_BASE_URL` / `DEEPSEEK_MODEL` / `DEEPSEEK_PLANNER_MODEL` | 与 fixture CLI 相同；表单里的「规划模型」覆盖本次运行的 `DEEPSEEK_PLANNER_MODEL`。 |
| `DEEPSEEK_PRICE_TABLE(_JSON)` | 可选成本价目表；缺失时界面显示 `cost=unknown`。 |
| `AGENT_STORE_ROOT` | 运行存根目录（`LocalFileRunStore`），默认系统临时目录下的 `linonward-agent-console-runs`。 |
| `AGENT_CONSOLE_API_PORT` | API 端口，默认 `8787`（Vite 代理也读这个变量）。 |

`dev:api` / `dev` 会用 `node --env-file-if-exists=.env` 加载 `apps/agent-console/.env`
（不存在也能启动）。

## HTTP API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | `{ ok, apiKeyConfigured }`（不含密钥）。 |
| `POST` | `/api/run` | body `{ task, cwd, allowedArgv?, maxSteps?, maxToolCalls?, approveAllowed?, requireSandbox?, repeatGuard?, plannerModel? }` → `{ runId }`，立即返回。 |
| `GET` | `/api/runs/:runId/stream` | SSE：`event: journal`（journal 记录 JSON，含 `kind`；每帧带 `id: <seq>`）→ `run_stopped` 之后 `event: done` 并关闭。支持 `?after=<seq>` 断点续订。 |
| `GET` | `/api/runs` | 最近的运行列表（读磁盘 checkpoint）：`[{ runId, task?, savedAt?, status?, stopReason?, live }]`。 |
| `GET` | `/api/runs/:runId` | 最新 checkpoint 快照：`status` / `stopReason` / `budget` / `usage` / `changedFiles` / `validations` / `plan` / `messages` / `pending`（等待回答的请求）。 |
| `POST` | `/api/runs/:runId/answer` | body `{ requestId, text }`：审批 / 澄清后继续运行。 |

服务只监听 `127.0.0.1`，没有鉴权（本地工具）。

## 刷新 / 重开 / 继续一次运行

运行完全由 SSE 驱动，而频道活在 API 进程的内存里。所以"还能不能接着看/接着做"分成三层：

| 情况 | 数据来源 | 界面表现 |
| --- | --- | --- |
| 同一个 API 进程 | `?run=` → SSE `?after=0` 全量补发 | 完整时间线；等待中的请求照旧可提交 |
| 进程重启过，运行仍在等待回答 | `?run=` → checkpoint 快照；提交时服务端**从磁盘重建运行** | 快照面板 + 输入框，回答后运行继续（重建的频道会把历史一起补发） |
| 进程重启过，运行已结束 | checkpoint 快照 | 只说明状态与用量：这类运行没有"继续"，也不需要"实时流" |

"从磁盘重建"（`server/runner.ts` 的 `rehydrate`）用到三份已有产物：checkpoint 给出状态与计划，
journal 的 `run_started` 给出 cwd / 白名单 / 预算 / 是否自动批准，最后一条 `waiting` 记录带着
完整的审批请求（含 `actionDigest`，重新登记进新账本后才能批准）。重建时缺失的字段一律退回
保守值（没有 `approveAllowed` 就当作 false），绝不按更宽松的策略续跑。

两个边界条件界面会主动说出来，而不是让用户白填一次：

- **凭证过期**：审批凭证 15 分钟内有效（`APPROVAL_TTL_MS`）。过期的待答请求只显示
  `已过期` 与"请重新发起"，不给输入框。
- **lease 仍被占用**：若上一次进程还在跑（lease 未过期），`resume` 会以
  `lease_held_by_another_worker` 失败——这是刻意保留的 fencing，界面显示服务端返回的原因。

## 实现要点

- `server/runner.ts` 复用 `agent-cli.ts` 的装配思路（`createRealTaskRegistry`、
  `PreApprovingLedger`、`detectSandbox`、无状态 Responses 驱动、模型版规划器），
  并把 `createJournal` 的 write sink 换成"既写文件（`console.log`）又推进进程内事件总线"。
  journal 的结构化记录（`journal.jsonl`）由 `server/journal-tail.ts` 增量读取成实时流。
- `src/lib/journal.ts` 的 `projectRun` 是**纯函数**：journal 记录序列 → 按轮次分组的视图 +
  用量 / 成本 / 预算 / 结束原因聚合。界面、SSE 与测试共用同一份逻辑。
- 成本口径：优先采用运行结束的 `usage(scope=run)` 记录；回退到逐次累加时，只要有一次调用
  没给出 `costUsd`，就整体保持 `cost=unknown`（不做"部分求和"）。

### 关于跨包相对导入

`packages/agent-from-scratch-fixture/package.json` 的 `exports` 只暴露包根（`./src/index.ts`），
而控制台需要 `cli-journal` / `run-task` / `responses-http` 等非 barrel 模块。
为不改动 fixture 的既有 API，`server/` 里对这些模块使用相对路径导入
（`../../../packages/agent-from-scratch-fixture/src/*.js`），Vite 通过
`server.fs.allow` 放行仓库根。若以后 fixture 增加了子路径 `exports`，可以换成按包名导入。

## 测试

```sh
pnpm --filter @linonward/agent-console test
```

全部离线：投影 / 事件总线 / 路由的纯函数与注入假 runner 的 HTTP 测试，以及一个
`react-dom/server` 渲染测试。不会读取密钥、也不发真实模型请求。
