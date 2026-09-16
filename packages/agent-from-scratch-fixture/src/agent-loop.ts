import { randomUUID } from "node:crypto";
import { canonicalJson } from "./checkpoint.js";
import {
  type Compactor,
  compactionAsContextSources,
  maybeCompactContext,
  projectCompactedContext,
} from "./compaction.js";
import {
  checkCompletion,
  DELETED_FILE_HASH,
  describeMissingProgress,
  hashChangedFiles,
} from "./completion.js";
import { buildModelRequest, type ContextSource, summarizeSources } from "./context.js";
import { toDurableState } from "./durable-state.js";
import { executeToolCall, type ToolExecutionResult, type ToolObservation } from "./execute-tool.js";
import { waitForUserInput } from "./interaction.js";
import type { FunctionCallOutput, ModelDriver, ModelTurn, ModelUsage, ToolCall } from "./model.js";
import {
  allCriteriaPassed,
  allStepsCompleted,
  applyCriterionEvidence,
  assertEvidenceComesFromObservations,
  completeStep,
  createInitialPlan,
  planAsContextSource,
  reconcilePlan,
  selectNextStep,
  shouldReplan,
  startStep,
} from "./plan.js";
import type { Planner } from "./planner.js";
import {
  type ApprovalLedger,
  InMemoryApprovalLedger,
  type PolicyContext,
  type PolicyDecision,
} from "./policy.js";
import { estimateCostUsd, formatCostUsd, type PriceTable } from "./pricing.js";
import {
  createRunCheckpoint,
  type DurableEvent,
  type RunLease,
  type RunStore,
} from "./run-store.js";
import type { Sandbox } from "./sandbox.js";
import {
  activeSkillContextSources,
  discoverSkills,
  skillCatalogAsContextSource,
} from "./skill-catalog.js";
import { appendEvent, canTransition, createInitialState, transitionState } from "./state.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { InMemoryWriteLease, type WriteLease } from "./tool.js";
import type { ToolRegistry } from "./tool-registry.js";
import { addOptionalCounts, type RunUsage, type TraceSink } from "./trace.js";
import type {
  AgentResult,
  AgentState,
  Clock,
  PlanStep,
  StopReason,
  TaskPlan,
  ValidationRecord,
  ValidationSpec,
} from "./types.js";

/** `plan_revised` 里最多带几条触发证据（最近失败的工具）。 */
export const MAX_PLAN_REVISED_FAILURES = 3;
/** `plan_revised` 里每类步骤 id 最多列几条，超出写 `…(+N)`。 */
export const MAX_PLAN_REVISED_STEP_IDS = 10;

/**
 * 连续相同工具调用（`name` 相同且 `argumentsJson` 规范化后相同）的护栏阈值。
 *
 * - 第 `REPEAT_GUARD_FEEDBACK_THRESHOLD` 次：只追加一条 `harness_feedback` 提醒模型，
 *   仍然执行这次调用——它可能是合法的幂等重试；
 * - 第 `REPEAT_GUARD_BLOCK_THRESHOLD` 次：不再执行，直接返回结构化失败 observation，
 *   让剩余预算花在别的动作上。
 *
 * 判据只看 `name + 规范化 args`：换了 `path` 的 `apply_patch` 这类"同名不同参数"的重试
 * 完全不受影响。
 */
export const REPEAT_GUARD_FEEDBACK_THRESHOLD = 2;
export const REPEAT_GUARD_BLOCK_THRESHOLD = 3;
/** 写进 feedback / observation 的工具名上限：模型可能幻觉出任意长的名字。 */
export const MAX_REPEAT_GUARD_NAME_CHARACTERS = 80;

/** 触发一次重规划时，最近失败的工具（名字 + error code）。 */
export interface PlanRevisedFailure {
  name: string;
  errorCode?: string | undefined;
}

/**
 * `plan_revised` 的**有界**详情：回答操作者的两个问题——"为什么改"与"改了什么"。
 *
 * 每类步骤 id 都带上"因上限省略了几条"，因此 `…(+N)` 是精确的，不是"大概还有几条"。
 */
export interface PlanRevisedDetail {
  type: "plan_revised";
  reason: string;
  addedSteps: string[];
  removedSteps: string[];
  renamedSteps: string[];
  addedStepsOmitted: number;
  removedStepsOmitted: number;
  renamedStepsOmitted: number;
  /** 依赖列表发生变化的步骤数（不是变化了几条依赖）。 */
  dependencyChanges: number;
  recentFailures: PlanRevisedFailure[];
  recentFailuresOmitted: number;
}

/** 计划差异：新增 / 删除 / 标题变化 的步骤 id + 依赖变化次数，全部有界。 */
export function diffPlanSteps(
  before: TaskPlan,
  after: TaskPlan,
): {
  addedSteps: string[];
  removedSteps: string[];
  renamedSteps: string[];
  addedStepsOmitted: number;
  removedStepsOmitted: number;
  renamedStepsOmitted: number;
  dependencyChanges: number;
} {
  const beforeById = new Map(before.steps.map((step) => [step.id, step]));
  const afterById = new Map(after.steps.map((step) => [step.id, step]));

  const added = after.steps.filter((step) => !beforeById.has(step.id)).map((step) => step.id);
  const removed = before.steps.filter((step) => !afterById.has(step.id)).map((step) => step.id);
  // 只有"两边都在、标题变了"才算改名：新增的步骤不算，否则同一个 id 会被数两次。
  const renamed = after.steps
    .filter((step) => {
      const previous = beforeById.get(step.id);
      return previous !== undefined && previous.title !== step.title;
    })
    .map((step) => step.id);

  const dependencyChanges = after.steps.filter((step) => {
    const previous = beforeById.get(step.id);
    return previous !== undefined && !sameDependencies(previous.dependsOn, step.dependsOn);
  }).length;

  const addedSteps = added.slice(0, MAX_PLAN_REVISED_STEP_IDS);
  const removedSteps = removed.slice(0, MAX_PLAN_REVISED_STEP_IDS);
  const renamedSteps = renamed.slice(0, MAX_PLAN_REVISED_STEP_IDS);
  return {
    addedSteps,
    removedSteps,
    renamedSteps,
    addedStepsOmitted: added.length - addedSteps.length,
    removedStepsOmitted: removed.length - removedSteps.length,
    renamedStepsOmitted: renamed.length - renamedSteps.length,
    dependencyChanges,
  };
}

/** 依赖语义上是集合：顺序变化不算"改了什么"。 */
function sameDependencies(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].toSorted();
  const sortedRight = [...right].toSorted();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function buildPlanRevisedDetail(input: {
  before: TaskPlan;
  after: TaskPlan;
  reason: string;
  recentFailures: readonly PlanRevisedFailure[];
  failureCount: number;
}): PlanRevisedDetail {
  return {
    type: "plan_revised",
    reason: input.reason,
    ...diffPlanSteps(input.before, input.after),
    recentFailures: input.recentFailures.map((failure) => ({ ...failure })),
    recentFailuresOmitted: Math.max(0, input.failureCount - input.recentFailures.length),
  };
}

export type AgentLoopEvent =
  | { type: "run_started"; runId: string }
  | { type: "model_started"; step: number }
  | { type: "model_completed"; step: number }
  | {
      type: "plan_revised";
      version: number;
      reason: string;
      /** 有界详情（为什么改 / 改了什么 / 触发证据）。缺省时事件形状与以前完全一致。 */
      detail?: PlanRevisedDetail | undefined;
    }
  | { type: "run_stopped"; reason: StopReason };

/**
 * 成本估算接线。
 *
 * `modelId` 与 `table` 任一缺失都只表示"算不出成本"，而不是"成本是 0"：
 * `AgentState.usage.estimatedCostUsd` 会保持 `undefined`，输出 `cost=unknown`。
 */
export interface LoopPricing {
  modelId?: string | undefined;
  table?: PriceTable | undefined;
}

/** 上下文压缩接线：阈值来自 usage，安全边界由 `maybeCompactContext` 判定。 */
export interface LoopCompactionOptions {
  compactor: Compactor;
  contextWindowTokens: number;
  reservedOutputTokens: number;
  /** 默认 12：rawTail 至少覆盖最近一个完整工具批次。 */
  rawTailSize?: number | undefined;
  /** 只估算输入 token；默认按字符数高估（ceil(chars/3)），宁可高估不可低估。 */
  estimateInputTokens?:
    | ((input: { sources: ContextSource[]; instructions: string }) => number)
    | undefined;
}

/** 逐事件持久化接线：append-only 事件日志 + 边界检查点。 */
export interface LoopPersistence {
  store: RunStore;
  lease: RunLease;
}

export interface AgentLoopOptions {
  cwd: string;
  skillsDirectory: string;
  maxSteps: number;
  maxToolCalls: number;
  /** 花费上限（美元）。缺省不限制。 */
  maxCostUsd?: number | undefined;
  /** 墙钟上限（毫秒）。缺省不限制。 */
  maxWallMs?: number | undefined;
  toolTimeoutMs: number;
  model: ModelDriver;
  planner: Planner;
  tools: ToolRegistry;
  trace: TraceSink;
  validationSpecs?: ValidationSpec[] | undefined;
  policy?: PolicyContext | undefined;
  approvals?: ApprovalLedger | undefined;
  writeLease?: WriteLease | undefined;
  /** 可选注入的进程沙箱，透传给 `executeToolCall`。 */
  sandbox?: Sandbox | undefined;
  /** 调用方显式要求隔离；`true` 时 `run_command` 宁可拒绝也不无隔离执行。 */
  requireSandbox?: boolean | undefined;
  clock?: Clock | undefined;
  signal?: AbortSignal | undefined;
  /** 只在新建运行时有意义：持久化调用方要先知道 runId 才能取到 lease。 */
  runId?: string | undefined;
  onEvent?: ((event: AgentLoopEvent) => void) | undefined;
  /**
   * 每次工具调用结束后的观测钩子（参数、结果、耗时与策略决定）。
   * 未提供时行为与今天逐字节一致：连时钟都不会被额外读取。
   */
  onToolCall?:
    | ((input: {
        call: ToolCall;
        result: ToolExecutionResult;
        durationMs: number;
        policy?: PolicyDecision | undefined;
      }) => void)
    | undefined;
  /** 未提供时行为与今天完全一致：不压缩、不写 store。 */
  compaction?: LoopCompactionOptions | undefined;
  persistence?: LoopPersistence | undefined;
  /**
   * 成本估算接线（模型 id + 价目表）。未提供时 `usage.estimatedCostUsd` 保持
   * `undefined`，输出层显示 `cost=unknown`——绝不按 0 计。
   */
  pricing?: LoopPricing | undefined;
  /**
   * 连续相同工具调用的护栏，**默认开启**（属于 Harness 约束）：第 2 次提醒模型、
   * 第 3 次直接拦截。`false` 时回到旧行为——完全相同的调用也照常执行。
   */
  repeatGuard?: boolean | undefined;
}

/** 续跑时由恢复器注入：上一轮的 responseId 与尚未送达模型的结果。 */
export interface AgentLoopResume {
  previousResponseId?: string | undefined;
  outputs?: FunctionCallOutput[] | undefined;
}

/** 持久化失败是契约错误，绝不是模型/工具错误：必须立即停止本次运行。 */
export const PERSISTENCE_FAILURE_CODES: readonly string[] = [
  "stale_lease",
  "lease_not_held",
  "lease_held_by_another_worker",
  "unexpected_sequence",
];

export function isPersistenceFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return PERSISTENCE_FAILURE_CODES.some((code) => error.message.includes(code));
}

/**
 * 把权威状态按边界 flush 进 RunStore。
 *
 * 关键设计：**内存日志与 store 日志各自保持连续，不共用计数器**。
 * - `state.nextEventSequence` 只服务 `state.events`（检查点里的可读日志、压缩快照的 rawTail）；
 * - store 的 `expectedSequence` 由 `lastSequence + 1` 推出，与内存序号无关。
 *
 * 共用计数器会让 `createInitialState` 播种的 `run_started`、以及 `step_started` 这类
 * 只属于运行时的事件把 store 的序号顶偏，store 会立刻以 `unexpected_sequence` 拒绝写入。
 * 持久化失败一律返回 false，调用方必须立刻停止本次运行且不再写 store。
 */
interface DurableWriter {
  /** 同时写内存日志与 store（未配置持久化时只写内存）。 */
  persist(event: DurableEvent): Promise<boolean>;
  /** 只写内存日志：`DurableEvent` 里没有对应成员的运行时事件。 */
  persistRuntime(type: string, detail: string): void;
  checkpoint(now: Date): Promise<boolean>;
}

function createDurableWriter(input: {
  persistence: LoopPersistence | undefined;
  state: AgentState;
  clock: Clock | undefined;
}): DurableWriter {
  const persistence = input.persistence;
  const state = input.state;
  let initialized = false;
  let lastSequence = 0;

  const now = (): Date => input.clock?.now() ?? new Date();

  const appendMemory = (type: string, detail: string): void => {
    const last = state.events.at(-1);
    // `stop()` 已经登记过同一条停止事件：只补 store，不重复写内存。
    if (last !== undefined && last.type === type && last.detail === detail) return;

    state.events = [
      ...state.events,
      {
        eventId: randomUUID(),
        sequence: state.nextEventSequence,
        recordedAt: now().toISOString(),
        type,
        detail,
      },
    ];
    state.nextEventSequence += 1;
  };

  const initialize = async (): Promise<void> => {
    if (!persistence) return;
    const existing = await persistence.store.readEvents(state.runId, 0);
    lastSequence = existing.at(-1)?.sequence ?? 0;
    initialized = true;
  };

  const appendStore = async (event: DurableEvent): Promise<boolean> => {
    if (!persistence) return true;
    if (!initialized) await initialize();

    const sequence = lastSequence + 1;
    try {
      await persistence.store.append({
        runId: state.runId,
        expectedSequence: sequence,
        ownerId: persistence.lease.ownerId,
        epoch: persistence.lease.epoch,
        event,
        now: now(),
      });
    } catch (error) {
      // 任何写失败都意味着这次运行不再有可恢复的日志：安全停止，不再写 store。
      // 原因只记进内存日志；`failedAttempts` 是工具失败与快照投影的输入，不能污染。
      appendMemory(
        "persistence_failed",
        JSON.stringify({
          message: error instanceof Error ? error.message : String(error),
          event,
        }),
      );
      return false;
    }
    lastSequence = sequence;
    return true;
  };

  return {
    async persist(event) {
      appendMemory(event.type, JSON.stringify(event));
      return appendStore(event);
    },
    persistRuntime(type, detail) {
      appendMemory(type, detail);
    },
    async checkpoint(now) {
      if (!persistence) return true;
      if (!initialized) await initialize();
      // 还没生成计划就没有可持久化的权威状态，恢复链路由后续边界接管。
      if (!state.plan) return true;
      try {
        await persistence.store.saveCheckpoint(
          createRunCheckpoint({
            state: toDurableState(state),
            throughSequence: lastSequence,
            now,
          }),
          persistence.lease,
        );
      } catch (error) {
        appendMemory(
          "persistence_failed",
          JSON.stringify({
            message: error instanceof Error ? error.message : String(error),
            stage: "checkpoint",
          }),
        );
        return false;
      }
      return true;
    },
  };
}

interface LoopContext {
  options: AgentLoopOptions;
  approvals: ApprovalLedger;
  writeLease: WriteLease;
  usage: UsageTracker;
  emit(state: AgentState, event: AgentLoopEvent): void;
  now(): Date;
  persist(state: AgentState, event: DurableEvent): Promise<boolean>;
  persistRuntime(state: AgentState, type: string, detail: string): void;
  checkpoint(state: AgentState, now: Date): Promise<boolean>;
  durableFailed(): boolean;
  markDurableFailed(): void;
}

/**
 * 运行用量累加器。
 *
 * 累加器是**可变对象**，并且就是 `AgentState.usage` 本身：状态的所有派生副本
 * （`appendEvent` / `transitionState` 只做展开复制）共享同一个 `usage` 引用，
 * 因此就地累加对每个 return 点都可见，不需要在十几个出口处逐个回写。
 *
 * `durationMs` 是**整轮墙钟时间**，按"段"累加：`markElapsed` 只补上自上次标记以来
 * 经过的时间（用注入的 `Clock`），重复调用不会重复计时。段式累加让 `resume` 之后
 * 的墙钟时间接着涨，而不是从 0 重来。
 */
interface UsageTracker {
  /** 一次模型调用：累计 token（缺失即未知）与调用次数。 */
  recordModelCall(usage: ModelUsage | undefined): void;
  /** 一次工具调用：只累计次数，耗时归入墙钟时间。 */
  recordToolCall(): void;
  /** 把自上次标记以来经过的墙钟时间累加进 `durationMs`。 */
  markElapsed(): void;
  /** 收尾：补齐最后一段墙钟时间并重算成本。 */
  finish(): void;
}

function createUsageTracker(options: AgentLoopOptions, state: AgentState): UsageTracker {
  const usage = state.usage;
  const clockNow = (): Date => options.clock?.now() ?? new Date();
  let lastMarkMs = clockNow().getTime();

  const recomputeCost = (): void => {
    const modelId = options.pricing?.modelId;
    // 没有模型 id（或模型不在价目表里）时保持 `undefined`：输出 `cost=unknown`。
    usage.estimatedCostUsd =
      modelId === undefined ? undefined : estimateCostUsd(usage, modelId, options.pricing?.table);
  };

  const markElapsed = (): void => {
    const now = clockNow().getTime();
    usage.durationMs += Math.max(0, now - lastMarkMs);
    lastMarkMs = now;
  };

  return {
    recordModelCall(callUsage) {
      usage.modelCalls += 1;
      // 这次调用没报 usage 时增量是 `undefined`，合计随之为未知——绝不当 0 相加。
      usage.inputTokens = addOptionalCounts(usage.inputTokens, callUsage?.inputTokens);
      usage.outputTokens = addOptionalCounts(usage.outputTokens, callUsage?.outputTokens);
      usage.cachedInputTokens = addOptionalCounts(
        usage.cachedInputTokens,
        callUsage?.cachedInputTokens,
      );
      recomputeCost();
    },
    recordToolCall() {
      usage.toolCalls += 1;
    },
    markElapsed,
    finish() {
      markElapsed();
      recomputeCost();
    },
  };
}

function createLoopContext(options: AgentLoopOptions, usage: UsageTracker): LoopContext {
  const approvals = options.approvals ?? new InMemoryApprovalLedger();
  const writeLease = options.writeLease ?? new InMemoryWriteLease();

  const emit = (state: AgentState, event: AgentLoopEvent): void => {
    const failedStop = event.type === "run_stopped" && event.reason !== "final_answer";
    const blockedStop =
      event.type === "run_stopped" &&
      ["approval_required", "user_input_required", "blocked_plan", "cancelled"].includes(
        event.reason,
      );

    const traceEvent = {
      runId: state.runId,
      type: event.type,
      startedAt: (options.clock?.now() ?? new Date()).toISOString(),
      outcome: event.type.endsWith("started")
        ? ("started" as const)
        : blockedStop
          ? ("blocked" as const)
          : failedStop
            ? ("failed" as const)
            : ("passed" as const),
    };
    options.trace.record(failedStop ? { ...traceEvent, errorCode: event.reason } : traceEvent);
    options.onEvent?.(event);
  };

  let writer: DurableWriter | undefined;
  let writerState: AgentState | undefined;
  let durableFailed = false;

  const writerFor = (state: AgentState): DurableWriter => {
    // 状态是不可变更新：`waitForUserInput` / `writeStatusEvent` 会返回新对象。
    // writer 若继续绑定旧对象，检查点就会写出一份过期快照（例如丢掉 pendingUserInput），
    // 恢复链随即失效。状态对象一变就重绑；store 序号会从事件日志重新推导，不受影响。
    if (writer && writerState === state) return writer;
    writer = createDurableWriter({
      persistence: options.persistence,
      state,
      clock: options.clock,
    });
    writerState = state;
    return writer;
  };

  return {
    options,
    approvals,
    writeLease,
    usage,
    emit,
    now: () => options.clock?.now() ?? new Date(),
    async persist(state, event) {
      const result = await writerFor(state).persist(event);
      if (!result) durableFailed = true;
      return result;
    },
    persistRuntime(state, type, detail) {
      writerFor(state).persistRuntime(type, detail);
    },
    async checkpoint(state, now) {
      const result = await writerFor(state).checkpoint(now);
      if (!result) durableFailed = true;
      return result;
    },
    durableFailed: () => durableFailed,
    markDurableFailed: () => {
      durableFailed = true;
    },
  };
}

/**
 * 教程明确提醒"每轮都重新生成计划会抖动、浪费 token"。
 * 连续多轮只修订计划却没有任何步骤完成，说明计划在打转：停下来报告，而不是继续烧 token。
 */
const MAX_REPLANS_WITHOUT_PROGRESS = 3;

function statusForStop(reason: StopReason): AgentState["status"] {
  if (reason === "cancelled") return "cancelled";
  if (reason === "blocked_plan") return "blocked";
  if (reason === "approval_required" || reason === "user_input_required") return "waiting";
  return "failed";
}

/**
 * `blocked_plan` 的触发点。操作者必须能区分"根本没有计划""没有依赖就绪的步骤"
 * "模型要调工具但当前没有 active step"和"计划在打转"；否则只能从内存日志猜。
 */
export type PlanBlockedReason =
  | "missing_plan"
  | "no_ready_step"
  | "no_active_step"
  | "replan_thrash";

/** `plan_blocked` 事件 detail 里最多登记多少条未完成步骤：超出只保留计数。 */
export const MAX_PLAN_BLOCKED_PENDING_STEPS = 10;

interface PlanBlockedPendingStep {
  id: string;
  status: PlanStep["status"];
  dependsOn: string[];
  unmetDependencies: string[];
}

/** `plan_blocked` 事件 detail 的稳定形状：机器可读字段 + 一句人类摘要。 */
export interface PlanBlockedDetail {
  type: "plan_blocked";
  reason: PlanBlockedReason;
  summary: string;
  activeStepId?: string | undefined;
  pendingSteps: PlanBlockedPendingStep[];
  pendingStepsOmitted: number;
}

/** 未完成步骤的**有界**投影：只保留前 N 条，每条带依赖与未满足的依赖。 */
function planBlockedPendingSteps(state: AgentState): {
  pendingSteps: PlanBlockedPendingStep[];
  omitted: number;
} {
  const steps = state.plan?.steps ?? [];
  const completed = new Set(
    steps.filter((step) => step.status === "completed").map((step) => step.id),
  );
  const unfinished = steps.filter((step) => step.status !== "completed");
  const pendingSteps = unfinished.slice(0, MAX_PLAN_BLOCKED_PENDING_STEPS).map((step) => ({
    id: step.id,
    status: step.status,
    dependsOn: [...step.dependsOn],
    unmetDependencies: step.dependsOn.filter((dependency) => !completed.has(dependency)),
  }));

  return { pendingSteps, omitted: unfinished.length - pendingSteps.length };
}

const PLAN_BLOCKED_SUMMARY: Record<PlanBlockedReason, string> = {
  missing_plan: "运行状态下没有计划：没有可供选择或执行的步骤。",
  no_ready_step: "没有依赖就绪的待办步骤：请先完成或解除被阻塞的依赖，否则需要修订计划。",
  no_active_step: "模型请求了工具，但当前没有 active step，也没有可启动的 ready 步骤。",
  replan_thrash: "连续多轮只修订计划却没有任何步骤完成：继续只会消耗预算，因此停止。",
};

function describePlanBlocked(state: AgentState, reason: PlanBlockedReason): PlanBlockedDetail {
  const { pendingSteps, omitted } = planBlockedPendingSteps(state);
  const detail: PlanBlockedDetail = {
    type: "plan_blocked",
    reason,
    summary: PLAN_BLOCKED_SUMMARY[reason],
    pendingSteps,
    pendingStepsOmitted: omitted,
  };
  if (state.activeStepId !== undefined) detail.activeStepId = state.activeStepId;
  return detail;
}

/**
 * 停止前登记**可诊断**的阻塞原因。这是运行时事件（只进内存日志，不占用 store 的
 * 权威事件流），并随最终 `AgentResult.state.events` 返回给 CLI 与操作者。
 */
function recordPlanBlocked(
  state: AgentState,
  reason: PlanBlockedReason,
  context: LoopContext,
): void {
  context.persistRuntime(state, "plan_blocked", JSON.stringify(describePlanBlocked(state, reason)));
}

/**
 * `max_steps` / `max_tool_calls` 的触发点：停止原因必须能回答"卡在哪、模型最后在做什么、
 * 还差什么"。`plan_blocked` 已经有诊断，这两种预算停止在本事件里补齐同样的信息。
 */
export const BUDGET_EXHAUSTED_REASONS = [
  "max_steps",
  "max_tool_calls",
  "max_cost",
  "max_wall_ms",
] as const;
export type BudgetExhaustedReason = (typeof BUDGET_EXHAUSTED_REASONS)[number];

/** `budget_exhausted` 里最多登记多少条未完成步骤：与 `plan_blocked` 共用同一上限。 */
export const MAX_BUDGET_EXHAUSTED_PENDING_STEPS = MAX_PLAN_BLOCKED_PENDING_STEPS;
/** `budget_exhausted` 里最多登记多少条最近的工具调用。 */
export const MAX_BUDGET_EXHAUSTED_RECENT_TOOL_CALLS = 5;
/** 活动步骤的 `completionEvidence` 是模型文本：必须截断，否则 detail 无界。 */
export const MAX_BUDGET_EXHAUSTED_EVIDENCE_CHARACTERS = 200;

/** 累计用量投影：原始计数 + `formatCostUsd` 之后的成本（`undefined` 即 `unknown`）。 */
export interface BudgetExhaustedUsage {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cachedInputTokens?: number | undefined;
  modelCalls: number;
  toolCalls: number;
  durationMs: number;
  estimatedCostUsd?: number | undefined;
  cost: string;
}

export interface BudgetExhaustedBudget {
  modelSteps: number;
  maxSteps: number;
  toolCalls: number;
  maxToolCalls: number;
  maxCostUsd?: number | undefined;
  maxWallMs?: number | undefined;
}

export interface BudgetExhaustedActiveStep {
  status: PlanStep["status"];
  dependsOn: string[];
  completionEvidence: string;
}

export interface BudgetExhaustedToolCall {
  name: string;
  ok: boolean;
  errorCode?: string | undefined;
  /** 与**上一次**工具调用的 `name + 规范化 argsJson` 完全相同。 */
  repeated: boolean;
}

/** `budget_exhausted` 事件 detail 的稳定形状：**每个字段都有界**。 */
export interface BudgetExhaustedDetail {
  type: "budget_exhausted";
  reason: BudgetExhaustedReason;
  budget: BudgetExhaustedBudget;
  usage: BudgetExhaustedUsage;
  activeStepId?: string | undefined;
  activeStep?: BudgetExhaustedActiveStep | undefined;
  pendingSteps: PlanBlockedPendingStep[];
  pendingStepsOmitted: number;
  recentToolCalls: BudgetExhaustedToolCall[];
  recentToolCallsOmitted: number;
  /** 本 run 最后一次 `plan_revised` 的原因（没有修订过则省略）。 */
  lastReplanReason?: string | undefined;
}

function describeBudgetExhausted(
  state: AgentState,
  reason: BudgetExhaustedReason,
  context: LoopContext,
  toolCallLog: ToolCallLog,
): BudgetExhaustedDetail {
  const { budget, usage } = state;
  const modelId = context.options.pricing?.modelId;
  const costUsd =
    modelId === undefined
      ? undefined
      : estimateCostUsd(usage, modelId, context.options.pricing?.table);
  const { pendingSteps, omitted } = planBlockedPendingSteps(state);

  const detail: BudgetExhaustedDetail = {
    type: "budget_exhausted",
    reason,
    budget: {
      modelSteps: budget.modelSteps,
      maxSteps: budget.maxSteps,
      toolCalls: budget.toolCalls,
      maxToolCalls: budget.maxToolCalls,
      ...(budget.maxCostUsd !== undefined ? { maxCostUsd: budget.maxCostUsd } : {}),
      ...(budget.maxWallMs !== undefined ? { maxWallMs: budget.maxWallMs } : {}),
    },
    usage: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      modelCalls: usage.modelCalls,
      toolCalls: usage.toolCalls,
      durationMs: usage.durationMs,
      estimatedCostUsd: costUsd,
      // 算不出成本时写 `unknown`，绝不写 `$0.000000` 冒充免费。
      cost: formatCostUsd(costUsd),
    },
    pendingSteps,
    pendingStepsOmitted: omitted,
    ...toolCallLog.describe(),
  };

  if (state.activeStepId !== undefined) detail.activeStepId = state.activeStepId;
  const activeStep = state.plan?.steps.find((step) => step.id === state.activeStepId);
  if (activeStep !== undefined) {
    detail.activeStep = {
      status: activeStep.status,
      dependsOn: activeStep.dependsOn.slice(0, MAX_PLAN_BLOCKED_PENDING_STEPS),
      completionEvidence: activeStep.completionEvidence.slice(
        0,
        MAX_BUDGET_EXHAUSTED_EVIDENCE_CHARACTERS,
      ),
    };
  }
  const lastReplan = state.planHistory.at(-1);
  if (lastReplan !== undefined) detail.lastReplanReason = lastReplan.reason;

  return detail;
}

/**
 * 钱与时间的硬上限检查。
 *
 * 与 `maxSteps` / `maxToolCalls` 不同，这两个上限看的不是"做了多少次"，而是"已经花掉多少"，
 * 因此必须在**每次模型调用之后**立刻检查：否则一次昂贵的调用就能把上限远远甩在后面，
 * 而这一轮的工具还会继续被派发。
 *
 * 设了 `maxCostUsd` 却算不出价格（模型不在价目表里）时同样停下：不能因为"算不出钱"
 * 就当作没花钱继续跑。真正"一分没花"时（还没有任何模型调用）不触发。
 */
function readHardLimitHit(
  state: AgentState,
  context: LoopContext,
): "max_cost" | "max_wall_ms" | undefined {
  const { maxCostUsd, maxWallMs } = state.budget;
  if (maxCostUsd === undefined && maxWallMs === undefined) return undefined;

  // 墙钟只在停止边界才累加，检查前先补上这一段，否则上限永远看不到真实耗时。
  context.usage.markElapsed();

  if (maxWallMs !== undefined && state.usage.durationMs >= maxWallMs) return "max_wall_ms";

  if (maxCostUsd !== undefined && state.usage.modelCalls > 0) {
    const costUsd = state.usage.estimatedCostUsd;
    if (costUsd === undefined || costUsd >= maxCostUsd) return "max_cost";
  }

  return undefined;
}

/**
 * 预算停止的统一出口：先登记 `budget_exhausted`（运行时事件，只进内存日志），
 * 再走常规的 `finishStop`。顺序保证 `state.events` 里诊断在 `run_stopped` 之前。
 */
async function stopForBudget(
  state: AgentState,
  reason: BudgetExhaustedReason,
  context: LoopContext,
  toolCallLog: ToolCallLog,
): Promise<AgentResult> {
  // 先把墙钟时间补齐，detail 里的 `durationMs` 才是"到停止为止"的真实耗时；
  // `finishStop` 随后会再标记一次，只补上两次之间的极短一段。
  context.usage.markElapsed();
  context.persistRuntime(
    state,
    "budget_exhausted",
    JSON.stringify(describeBudgetExhausted(state, reason, context, toolCallLog)),
  );
  return finishStop(state, reason, context);
}

/** 停止事件同时是权威状态变更与 durable 事件，两者 payload 必须逐字节一致。 */
function writeStatusEvent(state: AgentState, reason: StopReason, now: Date): AgentState {
  const recorded = appendEvent(
    state,
    "run_stopped",
    JSON.stringify({ type: "run_stopped", reason }),
    now,
  );
  return {
    ...recorded,
    status: statusForStop(reason),
    stopReason: reason,
  };
}

function stop(state: AgentState, reason: StopReason, context: LoopContext): AgentResult {
  const status = statusForStop(reason);
  const stopped = canTransition(state.status, status)
    ? writeStatusEvent(state, reason, context.now())
    : appendEvent(state, "run_stopped", reason, context.now());

  context.emit(stopped, { type: "run_stopped", reason });
  return { status: stopped.status, answer: "", stopReason: reason, state: stopped };
}

/** 同 id 的 context source 只保留一份，恢复重放不会污染下一轮 Assemble。 */
function addToolObservation(
  state: AgentState,
  source: { id: string; label: string; content: string },
): void {
  if (state.contextSources.some((candidate) => candidate.id === source.id)) return;
  state.contextSources.push({
    id: source.id,
    kind: "tool_observation",
    label: source.label,
    content: source.content,
    priority: 80,
  });
}

/**
 * 停止的统一出口：先在内存里登记停止，再把 `run_stopped` 事件与检查点写进 store。
 *
 * waiting 也必须写检查点，否则崩溃后没有可恢复的边界。持久化失败时立刻返回
 * `interrupted`，并且不再尝试任何 store 写入。
 */
async function finishStop(
  state: AgentState,
  reason: StopReason,
  context: LoopContext,
): Promise<AgentResult> {
  // 停止点是这一段的结束：先把墙钟时间补齐，再写检查点，让持久化的 usage 不含"尾巴"。
  context.usage.markElapsed();
  const stopped = stop(state, reason, context);
  if (context.options.persistence) {
    const persisted = await context.persist(stopped.state, { type: "run_stopped", reason });
    if (persisted) await context.checkpoint(stopped.state, context.now());
  }
  if (context.durableFailed()) return interruptedResult(stopped.state);
  return stopped;
}

/** 只能写内存的降级结果：持久化围栏已经拒绝本次运行。 */
function interruptedResult(state: AgentState): AgentResult {
  const stopped = appendEvent(
    state,
    "run_stopped",
    JSON.stringify({ type: "run_stopped", reason: "interrupted" }),
  );
  return { status: "failed", answer: "", stopReason: "interrupted", state: stopped };
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObservation(observation: ToolObservation): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(observation.output);
  } catch {
    return undefined;
  }
  return isRecordValue(parsed) ? parsed : undefined;
}

async function recordToolObservation(input: {
  state: AgentState;
  call: ToolCall;
  observation: ToolObservation;
  specs: ValidationSpec[];
}): Promise<void> {
  const { state, call, observation } = input;
  const payload = parseObservation(observation);

  if (!observation.ok) {
    state.failedAttempts.push(
      `${call.name}: ${String(payload?.["error"] ?? observation.errorCode ?? "failed")}`,
    );
    return;
  }

  const data = payload?.["data"];
  const record = isRecordValue(data) ? data : undefined;

  if (
    observation.effect === "write" &&
    record !== undefined &&
    typeof record["path"] === "string"
  ) {
    const path = record["path"];
    if (!state.changedFiles.includes(path)) state.changedFiles.push(path);
    state.mutationRevision += 1;
    state.changedFileHashes[path] =
      typeof record["sha256"] === "string" ? record["sha256"] : DELETED_FILE_HASH;
  }

  if (call.name !== "run_command" || record === undefined) return;

  const command = record["command"];
  const args = record["args"];
  const exitCode = record["exitCode"];
  if (typeof command !== "string" || !Array.isArray(args) || typeof exitCode !== "number") return;

  const argv = [command, ...args.filter((value): value is string => typeof value === "string")];
  const spec = input.specs.find(
    (candidate) =>
      candidate.command === argv[0] &&
      candidate.args.length === argv.length - 1 &&
      candidate.args.every((value, index) => value === argv[index + 1]),
  );
  if (!spec) return;

  const validation: ValidationRecord = {
    id: `${call.callId}`,
    command: spec.command,
    args: spec.args,
    exitCode,
    durationMs: typeof record["durationMs"] === "number" ? record["durationMs"] : 0,
    status: exitCode === 0 ? "passed" : "failed",
    validatedRevision: state.mutationRevision,
    changedFileHashes: await hashChangedFiles(state.cwd, state.changedFiles),
    criterionIds: [...spec.criterionIds],
  };
  state.validations.push(validation);
}

function boundedToolName(name: string): string {
  return name.length <= MAX_REPEAT_GUARD_NAME_CHARACTERS
    ? name
    : `${name.slice(0, MAX_REPEAT_GUARD_NAME_CHARACTERS)}...`;
}

/** 第 2 次完全相同的调用：明确告诉模型"你在重复"，而不是让它自己察觉。 */
function repeatGuardFeedback(call: ToolCall): string {
  return `你刚刚用完全相同的参数再次调用了 \`${boundedToolName(call.name)}\`；请先阅读上一次的 observation，或换一个动作；不要重复同一调用。`;
}

/** 第 3 次完全相同的调用：不执行工具，只回一条结构化失败，让模型换动作。 */
function repeatedCallObservation(call: ToolCall): ToolObservation {
  return {
    type: "observation",
    callId: call.callId,
    ok: false,
    effect: "unknown",
    errorCode: "repeated_tool_call",
    output: JSON.stringify({
      ok: false,
      error: "repeated_tool_call",
      message: `同一个工具（${boundedToolName(call.name)}）与完全相同的参数已经连续调用 ${REPEAT_GUARD_BLOCK_THRESHOLD} 次，这次不再执行；请阅读上一次的 observation，或换一个动作。`,
    }),
  };
}

/**
 * 规范化后的调用指纹：JSON key 顺序不同、语义相同的参数视为同一次调用。
 * 解析失败时退回原文（非法 JSON 会在 executor 里变成 `invalid_json` 观察）。
 */
function toolCallSignature(call: ToolCall): string {
  let normalized = call.argumentsJson;
  try {
    normalized = canonicalJson(JSON.parse(call.argumentsJson));
  } catch {
    normalized = call.argumentsJson;
  }
  return `${call.name}\u0000${normalized}`;
}

/** 登记一次工具调用结果时用到的字段（waiting 没有 observation，记 `ok: false`）。 */
interface RecordedToolOutcome {
  ok: boolean;
  errorCode?: string | undefined;
}

/**
 * 有界的工具调用记录：既是"连续相同调用"守卫的计数器，也是预算停止诊断的数据源。
 *
 * 连续计数只在 `countConsecutive` 里推进（执行之前判定），结果在 `record` 里登记。
 * 模型某轮完全不调工具时调用 `resetConsecutive`：否则"失败一次 → 被 Harness 打回 →
 * 重试同一动作"会被误判成原地打转。
 */
class ToolCallLog {
  private readonly recent: BudgetExhaustedToolCall[] = [];
  private total = 0;
  private previousSignature: string | undefined;
  private consecutive = 0;

  /** 返回这次调用是连续第几次完全相同的调用（1 = 与上一次不同）。 */
  countConsecutive(call: ToolCall): number {
    const signature = toolCallSignature(call);
    this.consecutive = signature === this.previousSignature ? this.consecutive + 1 : 1;
    this.previousSignature = signature;
    return this.consecutive;
  }

  record(call: ToolCall, outcome: RecordedToolOutcome, repeated: boolean): void {
    this.total += 1;
    const entry: BudgetExhaustedToolCall = {
      name: call.name,
      ok: outcome.ok,
      repeated,
    };
    if (outcome.errorCode !== undefined) entry.errorCode = outcome.errorCode;
    this.recent.push(entry);
    if (this.recent.length > MAX_BUDGET_EXHAUSTED_RECENT_TOOL_CALLS) this.recent.shift();
  }

  resetConsecutive(): void {
    this.previousSignature = undefined;
    this.consecutive = 0;
  }

  describe(): {
    recentToolCalls: BudgetExhaustedToolCall[];
    recentToolCallsOmitted: number;
  } {
    return {
      recentToolCalls: this.recent.map((entry) => ({ ...entry })),
      recentToolCallsOmitted: Math.max(0, this.total - this.recent.length),
    };
  }
}

function recentObservations(state: AgentState): string[] {
  return state.contextSources
    .filter((source) => source.kind === "tool_observation")
    .slice(-20)
    .map((source) => source.content);
}

/** 没有快照时保持今天的形状；有快照时用"快照 + rawTail"替换被覆盖的旧历史。 */
function projectHistorySources(state: AgentState, rawTailSize: number): ContextSource[] {
  const latest = state.compaction.snapshots.at(-1);
  if (!latest) return [...state.contextSources];
  return [
    ...state.contextSources.filter((source) => source.kind !== "tool_observation"),
    ...compactionAsContextSources(
      projectCompactedContext({ snapshot: latest, events: state.events, rawTailSize }),
    ),
  ];
}

/** 默认按字符数高估输入 token（宁可高估不可低估，避免压缩迟到）。 */
function estimateInputTokens(input: { sources: ContextSource[]; instructions: string }): number {
  const characters = input.sources.reduce(
    (total, source) => total + source.kind.length + source.content.length + 16,
    0,
  );
  return Math.ceil((characters + input.instructions.length) / 3);
}

function assembleSources(input: {
  state: AgentState;
  plan: TaskPlan;
  activeStep: PlanStep | undefined;
  historySources: ContextSource[];
}): ContextSource[] {
  return [
    ...input.historySources,
    planAsContextSource(input.plan, input.activeStep),
    skillCatalogAsContextSource(input.state.skills.catalog),
    ...activeSkillContextSources(input.state.skills),
  ];
}

/** 新建一次运行：创建状态、发现 Skill、生成并校验初始计划。 */
export async function runAgentLoop(task: string, options: AgentLoopOptions): Promise<AgentResult> {
  const state = createInitialState(
    task,
    options.cwd,
    {
      maxSteps: options.maxSteps,
      maxToolCalls: options.maxToolCalls,
      ...(options.maxCostUsd !== undefined ? { maxCostUsd: options.maxCostUsd } : {}),
      ...(options.maxWallMs !== undefined ? { maxWallMs: options.maxWallMs } : {}),
    },
    { now: options.clock?.now() ?? new Date(), runId: options.runId },
  );

  state.skills.catalog = await discoverSkills(options.skillsDirectory);
  state.plan = await createInitialPlan(
    task,
    summarizeSources(state.contextSources),
    options.tools.names(),
    options.planner,
  );
  state.requiredCriterionIds = state.plan.acceptanceCriteria.map((criterion) => criterion.id);

  return runAgentLoopFromState(state, options);
}

/**
 * 完整 Agent Loop 的控制流：预算守卫 → 选步 → Assemble → model.start/continue
 * → userInputRequest / 工具批次 / 最终文本 → observation 入上下文 → planner.evaluate
 * → 证据校验 → 提前完成被打回 → plan_revised → 停止原因。
 *
 * `runAgentLoopFromState` 不重置预算，也不重新创建任务或计划。
 *
 * 用量（token / 缓存命中 / 调用计数 / 墙钟时间 / 估算成本）累加在 `state.usage` 上，
 * 随检查点持久化，`resume` 后继续累计。这里只在最外层补上"最后一段墙钟时间"：
 * 停止边界（`finishStop` / 最终答案）已经各自标记过一次，重复标记不会重复计时。
 */
export async function runAgentLoopFromState(
  state: AgentState,
  options: AgentLoopOptions,
  resume: AgentLoopResume = {},
): Promise<AgentResult> {
  const usage = createUsageTracker(options, state);
  try {
    return await runLoopFromState(state, options, resume, usage);
  } finally {
    usage.finish();
  }
}

async function runLoopFromState(
  state: AgentState,
  options: AgentLoopOptions,
  resume: AgentLoopResume,
  usageTracker: UsageTracker,
): Promise<AgentResult> {
  const context = createLoopContext(options, usageTracker);
  const toolDefinitions = options.tools.definitions();
  const specs = options.validationSpecs ?? [];

  let previousResponseId = resume.previousResponseId;
  let pendingOutputs: FunctionCallOutput[] = resume.outputs ?? [];
  let consecutiveToolFailures = 0;
  let lastReplannedVersion = -1;
  /** 连续"修订了计划但没有任何步骤完成"的次数。 */
  let replansWithoutProgress = 0;
  let lastPersistedPlanVersion = -1;
  let consecutiveCompactionFailures = 0;
  /** 本段里失败过的工具（最多保留最近 `MAX_PLAN_REVISED_FAILURES` 条）与失败总数。 */
  let recentToolFailures: PlanRevisedFailure[] = [];
  let toolFailureCount = 0;
  /** 连续相同调用的守卫与预算停止诊断共用的有界记录。 */
  const toolCallLog = new ToolCallLog();
  /** 默认开启；只有显式 `repeatGuard: false`（CLI 的 `--no-repeat-guard`）才关闭。 */
  const repeatGuardEnabled = options.repeatGuard !== false;

  const rawTailSize = options.compaction?.rawTailSize ?? 12;
  const estimateTokens = options.compaction?.estimateInputTokens ?? estimateInputTokens;

  const persistPlan = async (plan: TaskPlan): Promise<void> => {
    if (plan.version === lastPersistedPlanVersion) return;
    lastPersistedPlanVersion = plan.version;
    await context.persist(state, { type: "plan_updated", plan });
  };

  context.emit(state, { type: "run_started", runId: state.runId });
  if (options.persistence) {
    // store 为空时先落盘 `run_started`，否则新运行的事件日志会缺少开头。
    if (!(await context.persist(state, { type: "run_started", task: state.task }))) {
      return interruptedResult(state);
    }
  }
  if (!state.plan) {
    recordPlanBlocked(state, "missing_plan", context);
    return finishStop(state, "blocked_plan", context);
  }
  await persistPlan(state.plan);
  if (!(await context.checkpoint(state, context.now()))) return interruptedResult(state);

  // 续跑时上一批工具调用的对账结果已经写回，但模型还没看到它们，计划也还没归约过。
  // 先把它们折进计划与上下文；否则第一轮续跑会丢掉这些证据——provider cursor 不可复用时
  // 尤其明显，因为 `model.start` 不会携带 `function_call_output`。
  if (pendingOutputs.length > 0) {
    const observations = pendingOutputs.map((output) => output.output);
    let activeStep = state.plan.steps.find((step) => step.id === state.activeStepId);

    if (!activeStep) {
      const ready = selectNextStep(state.plan);
      if (ready) {
        state.plan = startStep(state.plan, ready.id);
        state.activeStepId = ready.id;
        activeStep = state.plan.steps.find((step) => step.id === ready.id);
      }
    }

    if (activeStep) {
      try {
        const progress = await options.planner.evaluate({
          step: activeStep,
          observations,
          acceptanceCriteria: state.plan.acceptanceCriteria,
        });
        assertEvidenceComesFromObservations(progress.evidence, observations);
        let plan = applyCriterionEvidence(state.plan, progress.passedCriteria, observations);
        if (progress.completed) {
          plan = completeStep(plan, activeStep.id, progress.evidence.join("\n"));
          state.activeStepId = undefined;
          replansWithoutProgress = 0;
        }
        state.plan = plan;
        await persistPlan(plan);
      } catch {
        return finishStop(state, "invalid_model_output", context);
      }
    }

    for (const output of pendingOutputs) {
      state.contextSources.push({
        id: output.call_id,
        kind: "tool_observation",
        label: "reconciled tool result",
        content: output.output,
        priority: 80,
      });
    }
    pendingOutputs = [];
    previousResponseId = undefined;
    if (!(await context.checkpoint(state, context.now()))) return interruptedResult(state);
  }

  while (state.status === "running") {
    if (options.signal?.aborted) return finishStop(state, "cancelled", context);
    if (state.budget.modelSteps >= state.budget.maxSteps) {
      return stopForBudget(state, "max_steps", context, toolCallLog);
    }
    const hardLimit = readHardLimitHit(state, context);
    if (hardLimit !== undefined) return stopForBudget(state, hardLimit, context, toolCallLog);

    let plan: TaskPlan | undefined = state.plan;
    if (!plan) {
      recordPlanBlocked(state, "missing_plan", context);
      return finishStop(state, "blocked_plan", context);
    }

    const replanReason = shouldReplan({
      userChangedGoal: false,
      failedAssumption: false,
      consecutiveToolFailures,
      plan,
    });

    if (replanReason !== undefined && plan.version !== lastReplannedVersion) {
      lastReplannedVersion = plan.version;
      const draft = await options.planner.revise({
        current: plan,
        reason: replanReason,
        observations: recentObservations(state),
      });
      const previous = plan;
      plan = reconcilePlan(plan, draft, replanReason);
      state.plan = plan;
      state.requiredCriterionIds = plan.acceptanceCriteria.map((criterion) => criterion.id);
      state.activeStepId = undefined;
      state.planHistory.push({
        version: plan.version,
        reason: replanReason,
        changedAt: context.now().toISOString(),
      });
      consecutiveToolFailures = 0;
      context.emit(state, {
        type: "plan_revised",
        version: plan.version,
        reason: replanReason,
        detail: buildPlanRevisedDetail({
          before: previous,
          after: plan,
          reason: replanReason,
          recentFailures: recentToolFailures,
          failureCount: toolFailureCount,
        }),
      });
      if (++replansWithoutProgress > MAX_REPLANS_WITHOUT_PROGRESS) {
        context.persistRuntime(
          state,
          "replan_thrash",
          JSON.stringify({ attempts: replansWithoutProgress, reason: replanReason }),
        );
        recordPlanBlocked(state, "replan_thrash", context);
        return finishStop(state, "blocked_plan", context);
      }
      await persistPlan(plan);
      continue;
    }

    let activeStep: PlanStep | undefined = plan.steps.find(
      (step) => step.id === state.activeStepId,
    );

    if (!activeStep) {
      const ready = selectNextStep(plan);
      if (ready) {
        plan = startStep(plan, ready.id);
        state.plan = plan;
        state.activeStepId = ready.id;
        activeStep = plan.steps.find((step) => step.id === ready.id);
        context.persistRuntime(state, "step_started", ready.id);
      } else if (plan.steps.some((step) => step.status !== "completed")) {
        recordPlanBlocked(state, "no_ready_step", context);
        return finishStop(state, "blocked_plan", context);
      }
    }

    // 每轮 Assemble 之前先压缩：阈值 + 安全边界都由 compaction 模块判定。
    let historySources = projectHistorySources(state, rawTailSize);
    const candidateInstructions = buildSystemPrompt({
      cwd: state.cwd,
      toolNames: options.tools.names(),
    });
    if (options.compaction) {
      const usage = {
        estimatedInputTokens: estimateTokens({
          sources: assembleSources({ state, plan, activeStep, historySources }),
          instructions: candidateInstructions,
        }),
        contextWindowTokens: options.compaction.contextWindowTokens,
        reservedOutputTokens: options.compaction.reservedOutputTokens,
      };

      try {
        const outcome = await maybeCompactContext({
          state,
          events: state.events,
          usage,
          // 压缩只在本轮开始（工具批次之间）调用：没有未决调用，
          // 上一批 outputs 也已经在本轮的 model.continue 里交给模型。
          pendingToolCallCount: 0,
          pendingOutputCount: 0,
          compactor: options.compaction.compactor,
          emit: async (event) => {
            // `compaction_completed` 由随后的 durable 写入登记（内存 + store），这里不重复。
            if (event.type === "compaction_completed") return;
            context.persistRuntime(state, event.type, JSON.stringify(event));
          },
          now: context.now(),
        });

        if (outcome.compacted) {
          consecutiveCompactionFailures = 0;
          // 内存日志用完整快照补齐：durable 事件与检查点因此完全一致。
          // 工具结果已由"快照 + rawTail"表达，避免与 rawTail 重复占用预算。
          state.contextSources = state.contextSources.filter(
            (source) => source.kind !== "tool_observation",
          );
          historySources = projectHistorySources(state, rawTailSize);
          if (outcome.snapshot) {
            await context.persist(state, {
              type: "compaction_completed",
              snapshot: outcome.snapshot,
            });
          }
          if (!(await context.checkpoint(state, context.now()))) {
            return interruptedResult(state);
          }
        }
      } catch (error) {
        // 校验失败：保留原上下文继续本轮，绝不用"差不多"的摘要。
        // 失败原因不写进 `state.failedAttempts`：那是工具失败与证据投影的输入，
        // 而它本身又会被 validateCompaction 逐项对照，写进去会让后续快照永远对不上。
        const reason = error instanceof Error ? error.message : String(error);
        consecutiveCompactionFailures += 1;
        if (consecutiveCompactionFailures >= 2) {
          context.persistRuntime(state, "compaction_failed", reason);
          return finishStop(state, "compaction_failed", context);
        }
      }
    }

    const request = buildModelRequest({
      task: state.task,
      cwd: state.cwd,
      toolNames: options.tools.names(),
      sources: assembleSources({ state, plan, activeStep, historySources }),
    });

    state.budget.modelSteps += 1;
    const modelStepCount = state.budget.modelSteps;
    context.emit(state, { type: "model_started", step: modelStepCount });

    let turn: ModelTurn;
    try {
      turn = previousResponseId
        ? await options.model.continue({
            previousResponseId,
            instructions: request.instructions,
            continuationContext: request.input,
            outputs: pendingOutputs,
            tools: toolDefinitions,
          })
        : await options.model.start({ request, tools: toolDefinitions });
    } catch (error) {
      state.steps.push({
        number: state.steps.length + 1,
        kind: "model",
        summary: error instanceof Error ? error.message : String(error),
      });
      return finishStop(state, "model_error", context);
    }

    state.steps.push({
      number: state.steps.length + 1,
      kind: "model",
      summary: turn.toolCalls.length > 0 ? "模型请求工具" : "模型返回文本",
    });
    // 用量在模型边界就记下：即使随后因持久化失败/取消停止，这一轮的 token 也不会丢。
    context.usage.recordModelCall(turn.usage);
    context.emit(state, { type: "model_completed", step: modelStepCount });
    // 这一轮完全没有请求工具：连续相同调用的计数清零。否则"工具失败一次 → 被 Harness
    // 打回 → 重试同一动作"会被误判成原地打转。
    if (turn.toolCalls.length === 0) toolCallLog.resetConsecutive();
    if (
      !(await context.persist(state, {
        type: "model_completed",
        responseId: turn.responseId,
        turn: {
          responseId: turn.responseId,
          finalText: turn.finalText,
          toolCalls: turn.toolCalls,
        },
      }))
    ) {
      return interruptedResult(state);
    }

    // 钱和时间在模型边界就已经花了：先判硬上限，再决定是否派发这一轮的工具或采纳答案。
    const hardLimitAfterTurn = readHardLimitHit(state, context);
    if (hardLimitAfterTurn !== undefined) {
      return stopForBudget(state, hardLimitAfterTurn, context, toolCallLog);
    }

    if (turn.userInputRequest && turn.toolCalls.length > 0) {
      return finishStop(state, "invalid_model_output", context);
    }

    if (turn.userInputRequest) {
      const waitingRequest = turn.userInputRequest;
      const waiting = waitForUserInput(state, waitingRequest, context.now());
      context.emit(waiting, { type: "run_stopped", reason: "user_input_required" });
      return finishStop(waiting, "user_input_required", context);
    }

    if (turn.toolCalls.length === 0) {
      const answer = turn.finalText.trim();
      if (!answer) return finishStop(state, "invalid_model_output", context);

      const completionError = await checkCompletion(state);
      const planCompleted = allStepsCompleted(plan);
      const criteriaPassed = allCriteriaPassed(plan);

      if (!planCompleted || !criteriaPassed || completionError !== undefined) {
        state.contextSources.push({
          id: "completion-rejected-" + modelStepCount,
          kind: "harness_feedback",
          label: "completion rejected",
          content: describeMissingProgress({ planCompleted, criteriaPassed, completionError }),
          priority: 100,
        });
        previousResponseId = undefined;
        pendingOutputs = [];
        continue;
      }

      state.messages.push({ role: "assistant", content: answer });
      const completed = transitionState(state, "completed", "final_answer", context.now());
      context.emit(completed, { type: "run_stopped", reason: "final_answer" });
      context.usage.markElapsed();
      if (!(await context.persist(completed, { type: "run_stopped", reason: "final_answer" }))) {
        return interruptedResult(completed);
      }
      await context.checkpoint(completed, context.now());
      if (context.durableFailed()) return interruptedResult(completed);
      return { status: "completed", answer, stopReason: "final_answer", state: completed };
    }

    // 同一批调用要么整体有预算，要么一个都不执行。
    if (state.budget.toolCalls + turn.toolCalls.length > state.budget.maxToolCalls) {
      return stopForBudget(state, "max_tool_calls", context, toolCallLog);
    }
    if (!activeStep) {
      recordPlanBlocked(state, "no_active_step", context);
      return finishStop(state, "blocked_plan", context);
    }

    const outputs: FunctionCallOutput[] = [];
    const observations: string[] = [];
    let batchOk = true;

    context.persistRuntime(
      state,
      "tool_batch_started",
      JSON.stringify({ responseId: turn.responseId, calls: turn.toolCalls.length }),
    );

    for (const call of turn.toolCalls) {
      if (options.signal?.aborted) return finishStop(state, "cancelled", context);

      const idempotencyKey = `${state.runId}:${call.callId}`;
      if (
        !(await context.persist(state, {
          type: "tool_intent",
          call: {
            callId: call.callId,
            name: call.name,
            argumentsJson: call.argumentsJson,
          },
          idempotencyKey,
        }))
      ) {
        return interruptedResult(state);
      }

      const hook = options.onToolCall;
      const hookStartedAt = hook === undefined ? undefined : context.now();

      // 连续相同调用（name + 规范化 args）的护栏：第 2 次先提醒，第 3 次直接拦截。
      const consecutive = toolCallLog.countConsecutive(call);
      if (repeatGuardEnabled && consecutive === REPEAT_GUARD_FEEDBACK_THRESHOLD) {
        state.contextSources.push({
          id: `repeat-guard-${call.callId}`,
          kind: "harness_feedback",
          label: "repeated tool call",
          content: repeatGuardFeedback(call),
          priority: 100,
        });
      }
      const blockedRepeat = repeatGuardEnabled && consecutive >= REPEAT_GUARD_BLOCK_THRESHOLD;

      const result = blockedRepeat
        ? repeatedCallObservation(call)
        : await executeToolCall({
            call,
            registry: options.tools,
            cwd: state.cwd,
            timeoutMs: options.toolTimeoutMs,
            policy: options.policy,
            approvals: context.approvals,
            runId: state.runId,
            writeLease: context.writeLease,
            skills: state.skills,
            sandbox: options.sandbox,
            requireSandbox: options.requireSandbox,
            signal: options.signal,
            now: context.now(),
            emit: (event) => {
              context.persistRuntime(state, event.type, JSON.stringify(event));
            },
          });
      // 被拦截的调用仍然是模型发出的工具调用：预算与用量照记，模型才会看到 observation。
      state.budget.toolCalls += 1;
      context.usage.recordToolCall();
      toolCallLog.record(
        call,
        result.type === "observation" ? result : { ok: false },
        consecutive >= REPEAT_GUARD_FEEDBACK_THRESHOLD,
      );

      if (hook !== undefined) {
        const durationMs =
          hookStartedAt === undefined ? 0 : context.now().getTime() - hookStartedAt.getTime();
        hook({ call, result, durationMs, policy: result.policy });
      }

      if (result.type === "waiting") {
        // 策略是在**派发之前**要求人工批准的，所以这次调用确定没有产生副作用。
        // 把这个事实落盘：否则它只是一条"有 intent、没有 result"的在途调用，恢复时会被
        // 判成"可能已经执行过"，要求人工对账（`no verifier registered for in-flight tool`），
        // 于是"批准之后继续"根本走不通。
        await context.persist(state, {
          type: "tool_result",
          callId: call.callId,
          idempotencyKey,
          output: JSON.stringify({
            ok: false,
            error: "not_executed",
            message: `awaiting_approval: 这次调用没有被执行，等待人工批准（requestId=${result.requestId}）`,
          }),
        });

        const waiting = transitionState(state, "waiting", result.reason, context.now());
        context.emit(waiting, { type: "run_stopped", reason: "approval_required" });
        return finishStop(waiting, "approval_required", context);
      }

      state.steps.push({ number: state.steps.length + 1, kind: "tool", summary: call.name });
      addToolObservation(state, { id: call.callId, label: call.name, content: result.output });
      outputs.push({ type: "function_call_output", call_id: call.callId, output: result.output });
      observations.push(result.output);

      await recordToolObservation({
        state,
        call,
        observation: result,
        specs,
      });
      if (!result.ok) {
        batchOk = false;
        toolFailureCount += 1;
        const failure: PlanRevisedFailure = { name: call.name };
        if (result.errorCode !== undefined) failure.errorCode = result.errorCode;
        // 只保留最近 N 条触发证据；总数单独记，`…(+N)` 才是精确的。
        recentToolFailures = [...recentToolFailures, failure].slice(-MAX_PLAN_REVISED_FAILURES);
      }

      if (
        !(await context.persist(state, {
          type: "tool_result",
          callId: call.callId,
          idempotencyKey,
          output: result.output,
        }))
      ) {
        return interruptedResult(state);
      }
    }

    consecutiveToolFailures = batchOk ? 0 : consecutiveToolFailures + 1;

    let progress: Awaited<ReturnType<Planner["evaluate"]>>;
    try {
      progress = await options.planner.evaluate({
        step: activeStep,
        observations,
        acceptanceCriteria: plan.acceptanceCriteria,
      });
      assertEvidenceComesFromObservations(progress.evidence, observations);
      if (progress.completed && progress.evidence.join("").trim().length === 0) {
        return finishStop(state, "invalid_model_output", context);
      }
    } catch {
      return finishStop(state, "invalid_model_output", context);
    }

    plan = applyCriterionEvidence(plan, progress.passedCriteria, observations);
    if (progress.completed) {
      plan = completeStep(plan, activeStep.id, progress.evidence.join("\n"));
      state.activeStepId = undefined;
      replansWithoutProgress = 0;
    }
    state.plan = plan;

    if (progress.replanReason) {
      const draft = await options.planner.revise({
        current: plan,
        reason: progress.replanReason,
        observations,
      });
      const previous = plan;
      plan = reconcilePlan(plan, draft, progress.replanReason);
      state.plan = plan;
      state.requiredCriterionIds = plan.acceptanceCriteria.map((criterion) => criterion.id);
      state.planHistory.push({
        version: plan.version,
        reason: progress.replanReason,
        changedAt: context.now().toISOString(),
      });
      context.emit(state, {
        type: "plan_revised",
        version: plan.version,
        reason: progress.replanReason,
        detail: buildPlanRevisedDetail({
          before: previous,
          after: plan,
          reason: progress.replanReason,
          recentFailures: recentToolFailures,
          failureCount: toolFailureCount,
        }),
      });
      state.activeStepId = undefined;
      if (++replansWithoutProgress > MAX_REPLANS_WITHOUT_PROGRESS) {
        context.persistRuntime(
          state,
          "replan_thrash",
          JSON.stringify({ attempts: replansWithoutProgress, reason: progress.replanReason }),
        );
        recordPlanBlocked(state, "replan_thrash", context);
        return finishStop(state, "blocked_plan", context);
      }
    }

    // 工具批次完成且计划/证据已更新：这是崩溃恢复的安全边界。
    await persistPlan(plan);
    if (!(await context.checkpoint(state, context.now()))) return interruptedResult(state);

    previousResponseId = turn.responseId;
    pendingOutputs = outputs;
  }

  return { status: state.status, answer: "", stopReason: "invalid_model_output", state };
}

/** 供 CLI 与 Capstone 复用：把权威状态投影成脱敏的运行摘要。 */
export function summarizeRun(state: AgentState): {
  runId: string;
  status: AgentState["status"];
  changedFiles: string[];
  mutationRevision: number;
  validations: number;
  modelSteps: number;
  toolCalls: number;
  usage: RunUsage;
} {
  return {
    runId: state.runId,
    status: state.status,
    changedFiles: [...state.changedFiles],
    mutationRevision: state.mutationRevision,
    validations: state.validations.length,
    modelSteps: state.budget.modelSteps,
    toolCalls: state.budget.toolCalls,
    usage: structuredClone(state.usage),
  };
}
