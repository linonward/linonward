import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
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
import { type JournalTailer, startJournalTailer } from "./journal-tail.js";
import { redactAll, secretValues } from "./redact.js";

export const CONSOLE_DEFAULT_MAX_STEPS = REAL_TASK_DEFAULT_MAX_STEPS;
export const CONSOLE_DEFAULT_MAX_TOOL_CALLS = REAL_TASK_DEFAULT_MAX_TOOL_CALLS;
export const CONSOLE_DEFAULT_STORE_ROOT = join(tmpdir(), "linonward-agent-console-runs");

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
  savedAt?: string | undefined;
  status?: string | undefined;
  stopReason?: string | undefined;
  budget?: unknown;
  usage?: unknown;
  changedFiles?: string[] | undefined;
  validations?: unknown;
  plan?: unknown;
  messages?: unknown;
}

export interface ConsoleRunner {
  start(input: StartRunInput): Promise<{ runId: string }>;
  answer(runId: string, input: { requestId: string; text: string }): Promise<void>;
  snapshot(runId: string): Promise<RunSnapshot | undefined>;
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
  /** 需要脱敏的密钥值：任何写回浏览器的文本都要先过一遍。 */
  secrets: string[];
  modelId: string | undefined;
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

/** 递归脱敏：任何字符串里的密钥值都会被替换，数组 / 对象的形状保持不变。 */
function redactValue(value: unknown, secrets: readonly string[], depth: number): unknown {
  if (typeof value === "string") return redactAll(value, secrets);
  if (depth > 8) return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets, depth + 1));
  if (isPlainObject(value)) {
    const nested: JournalRecord = {};
    for (const [key, item] of Object.entries(value)) {
      nested[key] = redactValue(item, secrets, depth + 1);
    }
    return nested;
  }
  return value;
}

function redactRecord(record: JournalRecord, secrets: readonly string[]): JournalRecord {
  const result: JournalRecord = {};
  for (const [key, value] of Object.entries(record)) {
    result[key] = redactValue(value, secrets, 0);
  }
  return result;
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
        channel.push(redactRecord(record, secrets));
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
        redactRecord({ kind: "plan_blocked", at, ...planBlocked }, context.secrets),
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
      return {
        runId: checkpoint.runId,
        savedAt: checkpoint.savedAt,
        status: state.status,
        stopReason: state.stopReason,
        budget: state.budget,
        usage: state.usage,
        changedFiles: state.changedFiles,
        validations: state.validations,
        plan: state.plan,
        messages: state.messages,
      };
    },
  };
}
