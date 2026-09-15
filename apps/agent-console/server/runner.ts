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
import { type JournalTailer, readLastWaitingRequest, startJournalTailer } from "./journal-tail.js";
import { redactAll, redactRecord, secretValues } from "./redact.js";

export const CONSOLE_DEFAULT_MAX_STEPS = REAL_TASK_DEFAULT_MAX_STEPS;
export const CONSOLE_DEFAULT_MAX_TOOL_CALLS = REAL_TASK_DEFAULT_MAX_TOOL_CALLS;
export const CONSOLE_DEFAULT_STORE_ROOT = join(tmpdir(), "linonward-agent-console-runs");

/** `GET /api/runs` 默认返回多少条：本地工具，够翻最近几次就够。 */
export const LIST_DEFAULT_LIMIT = 20;

export interface StartRunInput {
  task: string;
  cwd: string;
  allowedArgv: string[][];
  maxSteps: number;
  maxToolCalls: number;
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
  snapshot(runId: string): Promise<RunSnapshot | undefined>;
  list(limit?: number): Promise<RunSummary[]>;
}

export interface ConsoleRunnerOptions {
  env: NodeJS.ProcessEnv;
  hub: RunHub;
  storeRoot?: string | undefined;
  skillsDirectory?: string | undefined;
}

interface RunContext {
  runId: string;
  channel: RunChannel;
  journal: Journal;
  tailer: JournalTailer;
  base: AgentCliOptions;
  cliInput: CliRuntimeInput;
  runtime: AgentRuntime;
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

/** 真实运行器：`POST /api/run` 与 `POST /answer` 背后的实现。 */
export function createConsoleRunner(options: ConsoleRunnerOptions): ConsoleRunner {
  const env = options.env;
  const hub = options.hub;
  const storeRoot = options.storeRoot ?? env["AGENT_STORE_ROOT"] ?? CONSOLE_DEFAULT_STORE_ROOT;
  const skillsDirectory = options.skillsDirectory ?? defaultSkillsDirectory();
  const store = new LocalFileRunStore(storeRoot);
  const contexts = new Map<string, RunContext>();

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

    const client = createResponsesHttpClient({ apiKey: config.apiKey, baseUrl: config.baseUrl });
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
      signal: new AbortController().signal,
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
      ownerId: randomUUID(),
      pricing,
      store,
      approvals,
      secrets,
      modelId: config.model,
    };
  }

  function closeContext(context: RunContext): void {
    context.tailer.stop();
    context.journal.close();
    contexts.delete(context.runId);
  }

  /** 运行结束的收尾：先冲掉 journal 增量，再推 `run_stopped`，最后关闭频道。 */
  function settle(context: RunContext, result: AgentResult): void {
    const at = new Date().toISOString();
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
      const runId = randomUUID();
      const context = createContext(runId, input);
      contexts.set(runId, context);

      const state = createInitialState(
        input.task,
        input.cwd,
        { maxSteps: input.maxSteps, maxToolCalls: input.maxToolCalls },
        { runId },
      );
      context.journal.runMeta({
        command: "run",
        task: input.task,
        cwd: input.cwd,
        budgets: { maxSteps: input.maxSteps, maxToolCalls: input.maxToolCalls },
        allowedArgv: input.allowedArgv,
        requireSandbox: input.requireSandbox,
        modelId: context.modelId,
      });

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
      const context = contexts.get(runId);
      if (context === undefined) {
        throw new RunnerError(404, `未知的 runId：${runId}（进程重启后无法继续旧运行）`);
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

    async snapshot(runId) {
      const history = await store.loadCheckpointHistory(runId, 1);
      const checkpoint = history.at(0);
      if (checkpoint === undefined) return undefined;

      const state = checkpoint.state;
      const snapshot: RunSnapshot = {
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
        snapshot.pending = {
          requestId: state.pendingUserInput.id,
          question: state.pendingUserInput.question,
          reason: state.pendingUserInput.reason,
        };
      } else if (state.status === "waiting") {
        // 审批等待只看得到 journal 里的那条 waiting 记录；运行一旦离开 waiting
        // 就不该再翻出它（那会导致界面显示一个已经答过的请求）。
        const waiting = readLastWaitingRequest(join(storeRoot, runId, "journal.jsonl"));
        if (waiting !== undefined) {
          snapshot.pending = { requestId: waiting.requestId, question: "", reason: waiting.reason };
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
