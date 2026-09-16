import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  type AgentCliOptions,
  CLI_LEASE_TTL_MS,
  type CliRuntimeInput,
  createAgentCliRuntime,
  createAgentRuntime,
  runUsageEntry,
} from "@linonward/agent-from-scratch-fixture";

import {
  type AgentLoopEvent,
  type LoopPricing,
  runAgentLoop,
} from "../../../packages/agent-from-scratch-fixture/src/agent-loop.js";
import {
  createJournal,
  createJournalModelDriver,
  createJournalToolHook,
  type Journal,
} from "../../../packages/agent-from-scratch-fixture/src/cli-journal.js";
import { readBudgetExhaustedDetail } from "../../../packages/agent-from-scratch-fixture/src/cli-verbose.js";
import type { ModelDriver } from "../../../packages/agent-from-scratch-fixture/src/model.js";
import type { Planner } from "../../../packages/agent-from-scratch-fixture/src/planner.js";
import { createModelPlanner } from "../../../packages/agent-from-scratch-fixture/src/planner-model.js";
import type { PolicyContext } from "../../../packages/agent-from-scratch-fixture/src/policy.js";
import { resolvePriceTable } from "../../../packages/agent-from-scratch-fixture/src/pricing.js";
import {
  type AgentRuntime,
  loopOptionsFromRuntime,
} from "../../../packages/agent-from-scratch-fixture/src/recovery.js";
import {
  createResponsesHttpClient,
  createResponsesModel,
  type DeepSeekConfig,
  resolveDeepSeekConfig,
} from "../../../packages/agent-from-scratch-fixture/src/responses-http.js";
import { createStatelessResponsesDriver } from "../../../packages/agent-from-scratch-fixture/src/responses-stateless-driver.js";
import {
  LocalFileRunStore,
  type RunLease,
  type RunStore,
} from "../../../packages/agent-from-scratch-fixture/src/run-store.js";
import {
  createRealTaskRegistry,
  PreApprovingLedger,
  REAL_TASK_DEFAULT_MAX_STEPS,
  REAL_TASK_DEFAULT_MAX_TOOL_CALLS,
  REAL_TASK_DEFAULT_PLANNER_MAX_OBSERVATIONS,
} from "../../../packages/agent-from-scratch-fixture/src/run-task.js";
import { detectSandbox } from "../../../packages/agent-from-scratch-fixture/src/sandbox.js";
import { createInitialState } from "../../../packages/agent-from-scratch-fixture/src/state.js";
import type {
  AgentResult,
  AgentState,
} from "../../../packages/agent-from-scratch-fixture/src/types.js";
import { messageOf } from "../src/lib/format.js";
import { isPlainObject, type JournalRecord } from "../src/lib/journal.js";
import type { RunChannel, RunHub } from "./bus.js";
import {
  type JournalTailer,
  readLastWaitingRequest,
  readRunMeta,
  startJournalTailer,
} from "./journal-tail.js";
import { redactAll, redactRecord, secretValues } from "./redact.js";

export const CONSOLE_DEFAULT_MAX_STEPS = REAL_TASK_DEFAULT_MAX_STEPS;
export const CONSOLE_DEFAULT_MAX_TOOL_CALLS = REAL_TASK_DEFAULT_MAX_TOOL_CALLS;
export const CONSOLE_DEFAULT_STORE_ROOT = join(tmpdir(), "linonward-agent-console-runs");

/** 同时可以打开的运行上限的环境变量名（运行中 + 等待回答）。 */
export const CONSOLE_MAX_OPEN_RUNS_ENV = "AGENT_CONSOLE_MAX_OPEN_RUNS";

/** `GET /api/runs` 默认返回多少条：本地工具，够翻最近几次就够。 */
export const LIST_DEFAULT_LIMIT = 20;

export interface StartRunInput {
  task: string;
  cwd: string;
  allowedArgv: string[][];
  maxSteps: number;
  maxToolCalls: number;
  /** 花费上限（美元）：缺省不限制。 */
  maxCostUsd?: number | undefined;
  /** 墙钟上限（毫秒）：缺省不限制。 */
  maxWallMs?: number | undefined;
  approveAllowed: boolean;
  requireSandbox: boolean;
  repeatGuard: boolean;
  plannerModel?: string | undefined;
}

/** 路由层据此选状态码；`message` 已经过密钥脱敏。 */
export class RunnerError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "RunnerError";
    this.status = status;
  }
}

/** `GET /api/runs/:runId` 的返回：最新 checkpoint 的可序列化投影，**不含密钥**。 */
export interface RunSnapshot {
  runId: string;
  task?: string | undefined;
  savedAt?: string | undefined;
  status?: string | undefined;
  stopReason?: string | undefined;
  budget?: unknown;
  usage?: unknown;
  changedFiles?: string[] | undefined;
  validations?: unknown;
  plan?: unknown;
  messages?: unknown;
  /** 这个运行当前是否正在执行（决定界面上的"中止运行"是否可用）。 */
  cancellable?: boolean | undefined;
  /**
   * 等待回答的请求（审批 / 澄清）。刷新页面后实时流可能已经不存在，
   * 界面靠它把输入框重建出来，否则这次运行就永远卡在那里了。
   */
  pending?: RunPendingRequest | undefined;
}

export interface RunPendingRequest {
  requestId: string;
  question: string;
  reason: string;
  /** 审批凭证的过期时间（澄清请求可能没有）：过期后提交只会被拒绝。 */
  expiresAt?: string | undefined;
}

/** `GET /api/runs` 的列表项：一次运行在磁盘上的最新状态。 */
export interface RunSummary {
  runId: string;
  task?: string | undefined;
  savedAt?: string | undefined;
  status?: string | undefined;
  stopReason?: string | undefined;
  /** 本进程里还有活着的频道（界面可以接实时流）。 */
  live: boolean;
}

export interface ConsoleRunner {
  start(input: StartRunInput): Promise<{ runId: string }>;
  answer(runId: string, input: { requestId: string; text: string }): Promise<void>;
  /** 中止正在执行的运行：abort 会一路传到模型调用与工具（含整个进程组）。 */
  cancel(runId: string): Promise<void>;
  snapshot(runId: string): Promise<RunSnapshot | undefined>;
  list(limit?: number): Promise<RunSummary[]>;
}

export interface ConsoleRunnerOptions {
  env: NodeJS.ProcessEnv;
  hub: RunHub;
  storeRoot?: string | undefined;
  skillsDirectory?: string | undefined;
  /** 同时可以打开的运行上限；缺省时从 `AGENT_CONSOLE_MAX_OPEN_RUNS` 读。 */
  maxOpenRuns?: number | undefined;
}

/**
 * 超出并发上限时的拒绝。
 *
 * 上限按**打开的运行**计（运行中 + 等待回答）：等待中的运行同样各占一条频道、
 * 一个 journal 轮询与一份上下文，所以只数"正在跑"的并不足以保护进程。
 * 单独成函数是为了让边界能被离线测到，而不是藏在 `start` 的分支里。
 */
export function openRunRefusal(
  openCount: number,
  limit: number | undefined,
): RunnerError | undefined {
  if (limit === undefined || openCount < limit) return undefined;
  return new RunnerError(
    429,
    `同时打开的运行已达上限（${limit}）：请等其中一次结束，或调整 ${CONSOLE_MAX_OPEN_RUNS_ENV}`,
  );
}

/** 读出并发上限：非法值（0 / 负数 / 非数字）直接报错，而不是静默退回不限。 */
export function readMaxOpenRuns(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env[CONSOLE_MAX_OPEN_RUNS_ENV];
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${CONSOLE_MAX_OPEN_RUNS_ENV} 需要正整数，收到：${raw}`);
  }
  return parsed;
}

interface RunContext {
  runId: string;
  channel: RunChannel;
  journal: Journal;
  tailer: JournalTailer;
  base: AgentCliOptions;
  cliInput: CliRuntimeInput;
  runtime: AgentRuntime;
  /** 中止信号：一路传到模型调用与工具；`cancel` 只需要 abort 它。 */
  controller: AbortController;
  /** 是否有正在执行的循环（`waiting` 时为 false，此时没有东西可中止）。 */
  active: boolean;
  ownerId: string;
  pricing: LoopPricing;
  store: LocalFileRunStore;
  /** 批准账本：`answer` 靠它判断一个 requestId 是审批还是澄清。 */
  approvals: PreApprovingLedger;
  /** 需要脱敏的密钥值：任何写回浏览器的文本都要先过一遍。 */
  secrets: string[];
  modelId: string | undefined;
}

/** 一个 requestId 该走哪条续跑路径。 */
export type AnswerKind = "approval" | "user_input";

/**
 * 判断这次回答是"批准一个策略审批"还是"回复一次澄清"。
 *
 * 两条路径完全不同：澄清要把回答写进状态（`runtime.answer`），审批只需要在账本里
 * 批准那条 requestId，然后从 checkpoint 重新进入循环（`runtime.resume`）——重放的工具
 * 调用会在 `consumeApprovalGrant` 里拿到一次性凭证。走错路的症状很隐蔽：
 * HTTP 200，但运行立刻以 `unexpected_user_input` 失败。
 */
export async function resolveAnswerKind(
  approvals: PreApprovingLedger,
  runId: string,
  requestId: string,
): Promise<AnswerKind> {
  const pending = await approvals.pendingRequests(runId);
  return pending.some((request) => request.id === requestId) ? "approval" : "user_input";
}

/**
 * 澄清路径要求 requestId 与 checkpoint 里的 `pendingUserInput.id` 完全一致。
 *
 * 先查清楚再受理，免得把"打错字"变成一次 200 + `run_error`——那样界面会以为提交成功。
 * 匹配时返回 `undefined`。
 */
export async function clarificationMismatch(
  store: RunStore,
  runId: string,
  requestId: string,
): Promise<RunnerError | undefined> {
  let pendingId: string | undefined;
  try {
    const checkpoint = (await store.loadCheckpointHistory(runId, 1)).at(0);
    pendingId = checkpoint?.state.pendingUserInput?.id;
  } catch {
    // 读不到 checkpoint 时按"没有待答请求"处理，错误信息同样可读。
    pendingId = undefined;
  }

  if (pendingId === requestId) return undefined;
  return new RunnerError(
    400,
    pendingId === undefined
      ? `这次运行没有待回答的请求：${requestId}`
      : `requestId 不匹配：当前等待的是 ${pendingId}`,
  );
}

function defaultSkillsDirectory(): string {
  return resolve(
    import.meta.dirname,
    "..",
    "..",
    "..",
    "packages",
    "agent-from-scratch-fixture",
    "skills",
  );
}

/**
 * `plan_blocked` 的 detail 只存在于权威状态的运行时事件里（不是 journal 种类），
 * 因此这里把最后一条 `plan_blocked` 事件解析出来，随 `run_stopped` 一起推给界面。
 */
function readPlanBlockedDetail(state: AgentState): JournalRecord | undefined {
  const event = [...state.events].reverse().find((candidate) => candidate.type === "plan_blocked");
  if (event === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(event.detail);
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** 缺 key / 价目表写错都属于"调用方要修的东西"，映射成 4xx 而不是 500。 */
function resolveDeepSeek(
  env: NodeJS.ProcessEnv,
  plannerModel: string | undefined,
  secrets: readonly string[],
): {
  config: DeepSeekConfig;
  pricing: { modelId: string; table: ReturnType<typeof resolvePriceTable> };
} {
  let config: DeepSeekConfig;
  try {
    config = resolveDeepSeekConfig(env);
  } catch (error) {
    throw new RunnerError(400, redactAll(messageOf(error), secrets));
  }

  const resolved: DeepSeekConfig =
    plannerModel === undefined || plannerModel.length === 0 ? config : { ...config, plannerModel };

  let table: ReturnType<typeof resolvePriceTable>;
  try {
    table = resolvePriceTable(env);
  } catch (error) {
    throw new RunnerError(400, redactAll(messageOf(error), secrets));
  }

  return { config: resolved, pricing: { modelId: resolved.model, table } };
}

/**
 * 能不能中止一次运行：返回 `undefined` 表示可以，否则是给调用方的可读 4xx。
 *
 * 单独成函数是为了让"没有上下文"与"有上下文但没在执行"这两种拒绝都能被离线测到——
 * 它们的处理方式不同：前者是 404（进程重启后已经没有可中止的东西），后者是 409
 * （运行正停在等待回答，没有正在跑的任务）。
 */
export function cancelRefusal(
  context: { active: boolean } | undefined,
  runId: string,
): RunnerError | undefined {
  if (context === undefined) {
    return new RunnerError(404, `没有正在执行的运行：${runId}（进程重启后请重新发起）`);
  }
  if (!context.active) {
    return new RunnerError(
      409,
      `这次运行没有正在执行的任务（当前状态是"等待回答"或已结束），无需中止`,
    );
  }
  return undefined;
}

/** 真实运行器：`POST /api/run` 与 `POST /answer` 背后的实现。 */
export function createConsoleRunner(options: ConsoleRunnerOptions): ConsoleRunner {
  const env = options.env;
  const hub = options.hub;
  const storeRoot = options.storeRoot ?? env["AGENT_STORE_ROOT"] ?? CONSOLE_DEFAULT_STORE_ROOT;
  const skillsDirectory = options.skillsDirectory ?? defaultSkillsDirectory();
  const store = new LocalFileRunStore(storeRoot);
  const contexts = new Map<string, RunContext>();
  const maxOpenRuns = options.maxOpenRuns ?? readMaxOpenRuns(env);

  /**
   * 组装一次运行的进程内上下文。
   *
   * 刻意复用 `agent-cli.ts` 的装配思路：同一套工具注册表、策略、批准账本、沙箱检测、
   * 无状态 Responses 驱动与模型版规划器；区别只在于 journal 的 write sink 变成了
   * "既写文件、又推进进程内事件总线"，运行过程中由界面实时消费。
   */
  function createContext(runId: string, run: StartRunInput): RunContext {
    const secrets = secretValues(env);
    const { config, pricing } = resolveDeepSeek(env, run.plannerModel, secrets);

    // 取消信号必须一路传到 HTTP 客户端：否则"中止"只是不再进入下一步，
    // 却还要干等正在飞行中的那次模型调用（最长 60 秒）才真的停下。
    const controller = new AbortController();
    const client = createResponsesHttpClient({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      signal: controller.signal,
    });
    const model: ModelDriver = createStatelessResponsesDriver({ client, modelId: config.model });
    const planner: Planner = createModelPlanner(
      createResponsesModel({ client, modelId: config.plannerModel }),
      { maxObservations: REAL_TASK_DEFAULT_PLANNER_MAX_OBSERVATIONS },
    );

    const runDirectory = join(storeRoot, runId);
    mkdirSync(runDirectory, { recursive: true });
    const journalPath = join(runDirectory, "journal.jsonl");
    const logPath = join(runDirectory, "console.log");

    const channel = hub.create(runId);

    // write sink 双写：可读行落到 console.log，同时推进进程内事件总线。
    const writeLine = (line: string): void => {
      const safe = redactAll(line, secrets);
      appendFileSync(logPath, `${safe}\n`);
      channel.push({ kind: "log_line", at: new Date().toISOString(), text: safe });
    };

    const journal = createJournal({
      verbose: true,
      logPath: journalPath,
      truncate: true,
      write: writeLine,
    });

    // 结构化记录（带 kind）由 journal 的 JSONL 增量读取器变成实时流。
    const tailer = startJournalTailer({
      path: journalPath,
      onRecord: (record) => {
        channel.push(redactRecord(record, secrets) as JournalRecord);
      },
    });

    const onEvent = (event: AgentLoopEvent): void => {
      writeLine(JSON.stringify(event));
      if (event.type === "plan_revised") {
        journal.planRevised({ version: event.version, reason: event.reason, detail: event.detail });
      }
    };

    const approvals = new PreApprovingLedger();
    if (run.approveAllowed) approvals.allowPolicyApprovedCommands();

    const policy: PolicyContext = {
      cwd: run.cwd,
      realWorkspaceRoot: run.cwd,
      allowedArgv: run.allowedArgv,
      network: "disabled",
    };

    const base: AgentCliOptions = {
      cwd: run.cwd,
      skillsDirectory,
      store,
      // 装饰器在调用前后记录真实输入与输出（含思维链），与 CLI 完全同一套 journal。
      model: createJournalModelDriver(model, journal, pricing),
      planner,
      tools: createRealTaskRegistry(),
      policy,
      approvals,
      sandbox: detectSandbox(),
      requireSandbox: run.requireSandbox,
      maxSteps: run.maxSteps,
      maxToolCalls: run.maxToolCalls,
      pricing,
      repeatGuard: run.repeatGuard,
      onToolCall: createJournalToolHook(journal),
    };

    const cliInput: CliRuntimeInput = {
      cwd: run.cwd,
      skillsDirectory,
      signal: controller.signal,
      onEvent,
      journal,
    };

    return {
      runId,
      channel,
      journal,
      tailer,
      base,
      cliInput,
      runtime: createAgentRuntime(base, cliInput),
      controller,
      active: false,
      ownerId: randomUUID(),
      pricing,
      store,
      approvals,
      secrets,
      modelId: config.model,
    };
  }

  /**
   * 进程重启后从磁盘重建一次运行。
   *
   * 频道的缓冲活在进程内存里，所以重启后旧运行的实时流必然拿不到——但"运行本身"没有丢：
   * 检查点给出状态与计划，journal 的 `run_started` 给出 cwd / 白名单 / 预算 / 是否自动批准，
   * 最后一条 `waiting` 记录还带着完整的审批请求（含 `actionDigest`）。把这些拼回一个新的
   * 运行上下文，等待中的运行就还能被继续，而不是只剩一句"实时流不可用"。
   *
   * 缺数据时**退回保守默认值**：没有 `approveAllowed` 就当作 false——宁可多问一次，
   * 也不能凭猜测把一次运行按更宽松的策略续跑。
   */
  async function rehydrate(runId: string): Promise<RunContext | undefined> {
    const checkpoint = (await store.loadCheckpointHistory(runId, 1)).at(0);
    if (checkpoint === undefined) return undefined;

    const journalPath = join(storeRoot, runId, "journal.jsonl");
    const meta = readRunMeta(journalPath);
    const budgets = meta?.budgets;
    const input: StartRunInput = {
      task: meta?.task ?? checkpoint.state.task,
      cwd: meta?.cwd ?? checkpoint.state.cwd,
      allowedArgv: meta?.allowedArgv ?? [],
      maxSteps: budgets?.maxSteps ?? checkpoint.state.budget.maxSteps,
      maxToolCalls: budgets?.maxToolCalls ?? checkpoint.state.budget.maxToolCalls,
      // 上限同样按"记录在案"恢复；旧 journal 没有这两个字段时退回不限。
      ...(budgets?.maxCostUsd !== undefined
        ? { maxCostUsd: budgets.maxCostUsd }
        : checkpoint.state.budget.maxCostUsd !== undefined
          ? { maxCostUsd: checkpoint.state.budget.maxCostUsd }
          : {}),
      ...(budgets?.maxWallMs !== undefined
        ? { maxWallMs: budgets.maxWallMs }
        : checkpoint.state.budget.maxWallMs !== undefined
          ? { maxWallMs: checkpoint.state.budget.maxWallMs }
          : {}),
      approveAllowed: meta?.approveAllowed === true,
      requireSandbox: meta?.requireSandbox ?? false,
      repeatGuard: true,
    };

    const context = createContext(runId, input);
    // 把等待中的审批请求重新登记进新账本：没有它，`approve(requestId)` 会报 unknown。
    const waiting = readLastWaitingRequest(journalPath);
    if (waiting?.request !== undefined) {
      await context.approvals.saveApprovalRequest(runId, waiting.request);
    }
    contexts.set(runId, context);
    return context;
  }

  function closeContext(context: RunContext): void {
    context.active = false;
    context.tailer.stop();
    context.journal.close();
    contexts.delete(context.runId);
  }

  /** 运行结束的收尾：先冲掉 journal 增量，再推 `run_stopped`，最后关闭频道。 */
  function settle(context: RunContext, result: AgentResult): void {
    const at = new Date().toISOString();
    context.active = false;
    context.journal.usage(runUsageEntry(result, context.pricing));

    const budget = readBudgetExhaustedDetail(result.state);
    if (budget !== undefined) context.journal.budgetExhausted(budget);
    const planBlocked = readPlanBlockedDetail(result.state);
    if (planBlocked !== undefined) {
      context.channel.push(
        redactRecord(
          { kind: "plan_blocked", at, ...planBlocked },
          context.secrets,
        ) as JournalRecord,
      );
    }

    // 保证 journal 里的 usage / budget 记录先于 done 到达浏览器。
    context.tailer.flush();

    const detail: unknown = budget ?? planBlocked;
    const stopped: JournalRecord = {
      kind: "run_stopped",
      at,
      status: result.status,
      stopReason: result.stopReason,
    };
    if (detail !== undefined) stopped["detail"] = detail;
    context.channel.push(stopped);
    context.channel.finish();

    // `waiting`（审批 / 澄清）要留着 journal 与频道，等 `answer` 继续。
    if (result.status !== "waiting") closeContext(context);
  }

  function failContext(context: RunContext, error: unknown): void {
    const at = new Date().toISOString();
    context.active = false;
    context.tailer.flush();
    context.channel.push({
      kind: "run_error",
      at,
      message: redactAll(messageOf(error), context.secrets),
    });
    context.channel.push({ kind: "run_stopped", at, status: "failed" });
    context.channel.finish();
    closeContext(context);
  }

  async function runFromState(
    context: RunContext,
    task: string,
    state: AgentState,
    lease: RunLease,
  ): Promise<AgentResult> {
    try {
      // `runId` 必须显式传给 Loop：否则它会另生成一个，和已取的 lease / 已推的频道对不上。
      return await runAgentLoop(task, {
        ...loopOptionsFromRuntime(state, context.runtime, lease),
        runId: state.runId,
      });
    } finally {
      await store.releaseLease(lease);
    }
  }

  return {
    async start(input) {
      const refusal = openRunRefusal(contexts.size, maxOpenRuns);
      if (refusal !== undefined) throw refusal;

      const runId = randomUUID();
      const context = createContext(runId, input);
      contexts.set(runId, context);

      const state = createInitialState(
        input.task,
        input.cwd,
        {
          maxSteps: input.maxSteps,
          maxToolCalls: input.maxToolCalls,
          ...(input.maxCostUsd !== undefined ? { maxCostUsd: input.maxCostUsd } : {}),
          ...(input.maxWallMs !== undefined ? { maxWallMs: input.maxWallMs } : {}),
        },
        { runId },
      );
      context.journal.runMeta({
        command: "run",
        task: input.task,
        cwd: input.cwd,
        budgets: {
          maxSteps: input.maxSteps,
          maxToolCalls: input.maxToolCalls,
          ...(input.maxCostUsd !== undefined ? { maxCostUsd: input.maxCostUsd } : {}),
          ...(input.maxWallMs !== undefined ? { maxWallMs: input.maxWallMs } : {}),
        },
        allowedArgv: input.allowedArgv,
        requireSandbox: input.requireSandbox,
        approveAllowed: input.approveAllowed,
        modelId: context.modelId,
      });

      context.active = true;
      try {
        const lease = await store.acquireLease(runId, context.ownerId, CLI_LEASE_TTL_MS);
        void runFromState(context, input.task, state, lease)
          .then((result) => settle(context, result))
          .catch((error: unknown) => failContext(context, error));
      } catch (error) {
        failContext(context, error);
        throw new RunnerError(500, redactAll(messageOf(error), context.secrets));
      }

      return { runId };
    },

    async answer(runId, input) {
      // 进程重启后没有活上下文：先尝试从磁盘重建，能重建就继续，重建不了才是 404。
      const context = contexts.get(runId) ?? (await rehydrate(runId));
      if (context === undefined) {
        throw new RunnerError(404, `未知的 runId：${runId}（磁盘上没有这次运行的检查点）`);
      }

      // 审批与澄清的续跑语义都在 fixture 的 runtime 里（`grantApproval` vs `applyUserAnswer`），
      // 这里只补一层"打错字"的即时反馈：澄清的 requestId 必须与 checkpoint 完全一致，
      // 否则会变成一次 200 + run_error，界面还以为提交成功了。
      const kind = await resolveAnswerKind(context.approvals, runId, input.requestId);
      if (kind === "user_input") {
        const mismatch = await clarificationMismatch(store, runId, input.requestId);
        if (mismatch !== undefined) throw mismatch;
      }

      context.channel.reopen();
      context.active = true;
      const runtime = createAgentCliRuntime(context.base)(context.cliInput);

      void runtime
        .answer(runId, {
          requestId: input.requestId,
          content: input.text,
          receivedAt: new Date().toISOString(),
        })
        .then((result) => settle(context, result))
        .catch((error: unknown) => failContext(context, error));
    },

    /**
     * 中止一次运行。
     *
     * `abort` 会传到模型调用与工具层（`run_command` 因此会回收整个进程组），循环随即以
     * `cancelled` 停止并落检查点。**等待回答的运行没有可中止的东西**：它只是一个停下的
     * 检查点，因此返回 409 说明原因，而不是假装成功。
     */
    async cancel(runId) {
      const context = contexts.get(runId);
      const refusal = cancelRefusal(context, runId);
      if (refusal !== undefined) throw refusal;
      context?.controller.abort();
    },

    async snapshot(runId) {
      const history = await store.loadCheckpointHistory(runId, 1);
      const checkpoint = history.at(0);
      if (checkpoint === undefined) return undefined;

      const state = checkpoint.state;
      const snapshot: RunSnapshot = {
        cancellable: contexts.get(runId)?.active === true,
        runId: checkpoint.runId,
        status: state.status,
        budget: state.budget,
        usage: state.usage,
        changedFiles: state.changedFiles,
        validations: state.validations,
        plan: state.plan,
        messages: state.messages,
      };
      if (state.task.length > 0) snapshot.task = state.task;
      if (checkpoint.savedAt !== undefined) snapshot.savedAt = checkpoint.savedAt;
      if (state.stopReason !== undefined) snapshot.stopReason = state.stopReason;
      if (state.pendingUserInput !== undefined) {
        const pending: RunPendingRequest = {
          requestId: state.pendingUserInput.id,
          question: state.pendingUserInput.question,
          reason: state.pendingUserInput.reason,
        };
        if (state.pendingUserInput.expiresAt !== undefined) {
          pending.expiresAt = state.pendingUserInput.expiresAt;
        }
        snapshot.pending = pending;
      } else if (state.status === "waiting") {
        // 审批等待只看得到 journal 里的那条 waiting 记录；运行一旦离开 waiting
        // 就不该再翻出它（那会导致界面显示一个已经答过的请求）。
        const waiting = readLastWaitingRequest(join(storeRoot, runId, "journal.jsonl"));
        if (waiting !== undefined) {
          const pending: RunPendingRequest = {
            requestId: waiting.requestId,
            question: "",
            reason: waiting.reason,
          };
          if (waiting.request !== undefined) pending.expiresAt = waiting.request.expiresAt;
          snapshot.pending = pending;
        }
      }
      return snapshot;
    },

    /**
     * 最近的运行列表。
     *
     * 只读磁盘：`AGENT_STORE_ROOT` 下的每个目录就是一次运行，最新 checkpoint 给出它的
     * 状态。单个目录坏掉（读到一半被杀、不是运行目录）只跳过它自己，不影响整个列表。
     */
    async list(limit = LIST_DEFAULT_LIMIT) {
      let entries: string[];
      try {
        entries = await readdir(storeRoot);
      } catch {
        return [];
      }

      const summaries: RunSummary[] = [];
      for (const runId of entries) {
        try {
          const history = await store.loadCheckpointHistory(runId, 1);
          const checkpoint = history.at(0);
          if (checkpoint === undefined) continue;

          const channel = hub.get(runId);
          const summary: RunSummary = {
            runId,
            status: checkpoint.state.status,
            live: channel !== undefined && !channel.done,
          };
          if (checkpoint.state.task.length > 0) summary.task = checkpoint.state.task;
          if (checkpoint.savedAt !== undefined) summary.savedAt = checkpoint.savedAt;
          if (checkpoint.state.stopReason !== undefined) {
            summary.stopReason = checkpoint.state.stopReason;
          }
          summaries.push(summary);
        } catch {
          // 单个运行读不出来（目录被删、检查点损坏）不应让整个列表失败。
          continue;
        }
      }

      summaries.sort((left, right) => (right.savedAt ?? "").localeCompare(left.savedAt ?? ""));
      return summaries.slice(0, limit);
    },
  };
}
