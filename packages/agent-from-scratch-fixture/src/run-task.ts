import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runAgentLoop, summarizeRun, type AgentLoopEvent } from "./agent-loop.js";
import type { Compactor } from "./compaction.js";
import type { ModelDriver } from "./model.js";
import type { Planner } from "./planner.js";
import { createModelPlanner } from "./planner-model.js";
import {
  InMemoryApprovalLedger,
  type ApprovalGrant,
  type ApprovalLedger,
  type ApprovalRequest,
  type PolicyContext,
} from "./policy.js";
import {
  createResponsesModel,
  type DeepSeekConfig,
  type ResponsesHttpClient,
} from "./responses-http.js";
import { createStatelessResponsesDriver } from "./responses-stateless-driver.js";
import { LocalFileRunStore, type RunLease, type RunStore } from "./run-store.js";
import { detectSandbox, type Sandbox } from "./sandbox.js";
import { InMemoryWriteLease } from "./tool.js";
import { ToolRegistry } from "./tool-registry.js";
import { readFileTool } from "./tools/read-file.js";
import { searchTextTool } from "./tools/search-text.js";
import { applyPatchTool } from "./tools/apply-patch.js";
import { runCommandTool } from "./tools/run-command.js";
import { InMemoryTraceSink, type TraceEvent, type TraceSink } from "./trace.js";
import type { AgentResult, Clock, ValidationSpec } from "./types.js";

/** 真实运行的默认预算：比离线测试宽松，但仍然有界。 */
export const REAL_TASK_DEFAULT_MAX_STEPS = 16;
export const REAL_TASK_DEFAULT_MAX_TOOL_CALLS = 32;
export const REAL_TASK_DEFAULT_TOOL_TIMEOUT_MS = 60_000;
export const REAL_TASK_LEASE_TTL_MS = 10 * 60 * 1_000;
/** 默认压缩窗口大得不会触发：真实运行先把基础链路跑通，压缩另行显式开启。 */
export const REAL_TASK_DEFAULT_CONTEXT_WINDOW_TOKENS = 8_000_000;
export const REAL_TASK_DEFAULT_RESERVED_OUTPUT_TOKENS = 32_000;

export interface RunRealTaskOptions {
  cwd: string;
  model: ModelDriver;
  planner: Planner;
  /** 运行存根目录。省略时在系统临时目录下新建一个，并在结束后清理。 */
  storeRoot?: string | undefined;
  skillsDirectory?: string | undefined;
  trace?: TraceSink | undefined;
  clock?: Clock | undefined;
  signal?: AbortSignal | undefined;
  onEvent?: ((event: AgentLoopEvent) => void) | undefined;
  /** 命令白名单（必须是完整 argv，逐项相等才算匹配）。默认空：所有命令被拒。 */
  allowedArgv?: string[][] | undefined;
  validationSpecs?: ValidationSpec[] | undefined;
  /**
   * 只对**策略已经放行**的 `run_command` 自动批准。
   * 默认 `false`：无人值守的真实运行仍会停在 `approval_required`。
   * 打开它不会放宽 `allowedArgv`，白名单仍然是硬边界。
   */
  autoApproveAllowedCommands?: boolean | undefined;
  maxSteps?: number | undefined;
  maxToolCalls?: number | undefined;
  toolTimeoutMs?: number | undefined;
  /**
   * 进程隔离实现。默认 `detectSandbox()`：darwin → seatbelt，linux → bubblewrap，
   * 其它平台 → `noSandbox`。平台沙箱不可用时 `run_command` 会**拒绝执行**而不是无隔离运行。
   * 明确接受无隔离（例如只跑可信仓库自己的测试）时传入 `noSandbox`。
   */
  sandbox?: Sandbox | undefined;
  /**
   * 显式要求隔离，默认 `false`。无人值守地执行不可信仓库代码时应当打开：
   * 打开后任何"没有真隔离"的情况（未注入、`noSandbox`、平台沙箱不可用）都会
   * 让 `run_command` 返回 `sandbox_unavailable`，而不是静默降级。
   */
  requireSandbox?: boolean | undefined;
}

export interface RealTaskOutcome {
  result: AgentResult;
  trace: TraceEvent[];
  summary: ReturnType<typeof summarizeRun>;
}

/**
 * 与 Harness 完全相同的自动批准语义，只是把"人工点确认"换成"策略放行即批准"。
 *
 * 复用 `InMemoryApprovalLedger`：请求照旧落盘（可审计），批准凭证仍然绑定
 * `actionDigest`、仍然一次性、仍然会过期。白名单是策略层的硬边界。
 */
export class PreApprovingLedger implements ApprovalLedger {
  private readonly inner = new InMemoryApprovalLedger();
  private autoApprove = false;

  allowPolicyApprovedCommands(): void {
    this.autoApprove = true;
  }

  async saveApprovalRequest(runId: string, request: ApprovalRequest): Promise<void> {
    await this.inner.saveApprovalRequest(runId, request);
    if (this.autoApprove) await this.inner.approve(runId, request.id);
  }

  pendingRequests(runId: string): Promise<ApprovalRequest[]> {
    return this.inner.pendingRequests(runId);
  }

  approve(runId: string, requestId: string, now?: Date): Promise<ApprovalGrant> {
    return now === undefined
      ? this.inner.approve(runId, requestId)
      : this.inner.approve(runId, requestId, now);
  }

  consumeApprovalGrant(
    runId: string,
    actionDigest: string,
    now?: Date,
  ): Promise<ApprovalGrant | undefined> {
    return now === undefined
      ? this.inner.consumeApprovalGrant(runId, actionDigest)
      : this.inner.consumeApprovalGrant(runId, actionDigest, now);
  }

  invalidateRun(runId: string): Promise<void> {
    return this.inner.invalidateRun(runId);
  }
}

/** 真实运行可用的工具集合：与教程 00–17 章装配的那一套一致。 */
export function createRealTaskRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(readFileTool);
  registry.register(searchTextTool);
  registry.register(applyPatchTool);
  registry.register(runCommandTool);
  return registry;
}

/** 规划器默认只看最近 12 条 observation：evaluate 只需要判断"当前步骤是否被证明"。 */
export const REAL_TASK_DEFAULT_PLANNER_MAX_OBSERVATIONS = 12;

/** 真实通路的模型对：多轮循环用 `config.model`，规划用 `config.plannerModel`。 */
export interface DeepSeekTaskModels {
  model: ModelDriver;
  planner: Planner;
}

/**
 * 用同一份 `DeepSeekConfig` 装配"循环模型 + 模型版规划器"。
 *
 * 两者刻意分离：循环模型要处理长上下文与多轮工具调用；规划器只输出短 JSON，
 * 且判据是"本轮 observations 是否已证明 completionEvidence"，用独立的规划模型更好调参。
 * `resolveDeepSeekConfig` 保证 `plannerModel` 缺省回落到 `model`，因此不设
 * `DEEPSEEK_PLANNER_MODEL` 时行为与单模型完全一致。
 */
export function createDeepSeekTaskModels(input: {
  client: ResponsesHttpClient;
  config: DeepSeekConfig;
  maxObservations?: number | undefined;
}): DeepSeekTaskModels {
  const maxObservations = input.maxObservations ?? REAL_TASK_DEFAULT_PLANNER_MAX_OBSERVATIONS;
  return {
    model: createStatelessResponsesDriver({ client: input.client, modelId: input.config.model }),
    planner: createModelPlanner(
      createResponsesModel({ client: input.client, modelId: input.config.plannerModel }),
      { maxObservations },
    ),
  };
}

/**
 * 默认压缩器只会在"窗口被撑爆"时被调用，而默认窗口是 `REAL_TASK_DEFAULT_CONTEXT_WINDOW_TOKENS`。
 * 真被调用说明这个上限已经不合适：宁可显式失败，也不要静默产出一份"差不多"的摘要。
 * 需要压缩的真实运行应由调用方传入真正的 `compaction`。
 */
function neverCalledCompactor(): Compactor {
  return {
    compact: async () => {
      throw new Error("real_task_compaction_not_configured: 请为真实运行显式注入 compaction");
    },
  };
}

function defaultSkillsDirectory(): string {
  // `src/run-task.ts` → 包根目录 → `skills/`
  return resolve(import.meta.dirname, "..", "skills");
}

function buildPolicy(options: RunRealTaskOptions): PolicyContext {
  const root = resolve(options.cwd);
  return {
    cwd: root,
    realWorkspaceRoot: root,
    allowedArgv: options.allowedArgv ?? [],
    network: "disabled",
  };
}

function buildTraceSink(options: RunRealTaskOptions): TraceSink {
  return options.trace ?? new InMemoryTraceSink();
}

function readTrace(sink: TraceSink, runId: string): TraceEvent[] {
  return sink.readRun(runId);
}

/**
 * 真实任务的**装配与编排**：工具注册表、策略、trace、持久化、时钟、Skills、压缩。
 * 控制流完全复用 `runAgentLoop`，这里不复制任何 Loop 逻辑。
 *
 * 持久化使用 `LocalFileRunStore` + lease；每次运行结束都会释放 lease，
 * 调用方因此可以立刻对同一 store 做恢复或审查。
 */
export async function runRealTask(options: RunRealTaskOptions): Promise<RealTaskOutcome> {
  const runId = randomUUID();
  const temporaryStoreRoot = options.storeRoot === undefined;
  const storeRoot = options.storeRoot ?? (await mkdtemp(join(tmpdir(), "agent-real-run-store-")));
  const store: RunStore = new LocalFileRunStore(storeRoot);
  const trace = buildTraceSink(options);
  const clock = options.clock ?? { now: () => new Date() };
  const registry = createRealTaskRegistry();
  const approvals = new PreApprovingLedger();
  if (options.autoApproveAllowedCommands === true) approvals.allowPolicyApprovedCommands();

  let lease: RunLease | undefined;
  let started = false;

  try {
    lease = await store.acquireLease(runId, randomUUID(), REAL_TASK_LEASE_TTL_MS);
    started = true;

    const result = await runAgentLoop(options.cwd, {
      cwd: options.cwd,
      skillsDirectory: options.skillsDirectory ?? defaultSkillsDirectory(),
      maxSteps: options.maxSteps ?? REAL_TASK_DEFAULT_MAX_STEPS,
      maxToolCalls: options.maxToolCalls ?? REAL_TASK_DEFAULT_MAX_TOOL_CALLS,
      toolTimeoutMs: options.toolTimeoutMs ?? REAL_TASK_DEFAULT_TOOL_TIMEOUT_MS,
      model: options.model,
      planner: options.planner,
      tools: registry,
      trace,
      validationSpecs: options.validationSpecs,
      policy: buildPolicy(options),
      approvals,
      writeLease: new InMemoryWriteLease(),
      sandbox: options.sandbox ?? detectSandbox(),
      requireSandbox: options.requireSandbox ?? false,
      clock,
      signal: options.signal,
      onEvent: options.onEvent,
      runId,
      // 压缩已接线但窗口极大，默认不会触发；需要时由调用方替换 compaction。
      compaction: {
        compactor: neverCalledCompactor(),
        contextWindowTokens: REAL_TASK_DEFAULT_CONTEXT_WINDOW_TOKENS,
        reservedOutputTokens: REAL_TASK_DEFAULT_RESERVED_OUTPUT_TOKENS,
      },
      persistence: { store, lease },
    });

    return {
      result,
      trace: readTrace(trace, result.state.runId),
      summary: summarizeRun(result.state),
    };
  } finally {
    if (started && lease) await store.releaseLease(lease);
    if (temporaryStoreRoot) await rm(storeRoot, { recursive: true, force: true });
  }
}
