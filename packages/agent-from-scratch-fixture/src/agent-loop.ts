import { randomUUID } from "node:crypto";

import { buildModelRequest, summarizeSources, type ContextSource } from "./context.js";
import {
  DELETED_FILE_HASH,
  checkCompletion,
  describeMissingProgress,
  hashChangedFiles,
} from "./completion.js";
import {
  compactionAsContextSources,
  maybeCompactContext,
  projectCompactedContext,
  type Compactor,
} from "./compaction.js";
import { toDurableState } from "./durable-state.js";
import { executeToolCall, type ToolObservation } from "./execute-tool.js";
import { waitForUserInput } from "./interaction.js";
import type { FunctionCallOutput, ModelDriver, ModelTurn, ToolCall } from "./model.js";
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
import { InMemoryApprovalLedger, type ApprovalLedger, type PolicyContext } from "./policy.js";
import type { Sandbox } from "./sandbox.js";
import {
  createRunCheckpoint,
  type DurableEvent,
  type RunLease,
  type RunStore,
} from "./run-store.js";
import {
  activeSkillContextSources,
  discoverSkills,
  skillCatalogAsContextSource,
} from "./skill-catalog.js";
import { appendEvent, canTransition, createInitialState, transitionState } from "./state.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { InMemoryWriteLease, type WriteLease } from "./tool.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { TraceSink } from "./trace.js";
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

export type AgentLoopEvent =
  | { type: "run_started"; runId: string }
  | { type: "model_started"; step: number }
  | { type: "model_completed"; step: number }
  | { type: "plan_revised"; version: number; reason: string }
  | { type: "run_stopped"; reason: StopReason };

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
  /** 未提供时行为与今天完全一致：不压缩、不写 store。 */
  compaction?: LoopCompactionOptions | undefined;
  persistence?: LoopPersistence | undefined;
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
  emit(state: AgentState, event: AgentLoopEvent): void;
  now(): Date;
  persist(state: AgentState, event: DurableEvent): Promise<boolean>;
  persistRuntime(state: AgentState, type: string, detail: string): void;
  checkpoint(state: AgentState, now: Date): Promise<boolean>;
  durableFailed(): boolean;
  markDurableFailed(): void;
}

function createLoopContext(options: AgentLoopOptions): LoopContext {
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
  let durableFailed = false;

  const writerFor = (state: AgentState): DurableWriter => {
    if (writer) return writer;
    writer = createDurableWriter({
      persistence: options.persistence,
      state,
      clock: options.clock,
    });
    return writer;
  };

  return {
    options,
    approvals,
    writeLease,
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
    { maxSteps: options.maxSteps, maxToolCalls: options.maxToolCalls },
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
 */
export async function runAgentLoopFromState(
  state: AgentState,
  options: AgentLoopOptions,
  resume: AgentLoopResume = {},
): Promise<AgentResult> {
  const context = createLoopContext(options);
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
  if (!state.plan) return finishStop(state, "blocked_plan", context);
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
      return finishStop(state, "max_steps", context);
    }

    let plan: TaskPlan | undefined = state.plan;
    if (!plan) return finishStop(state, "blocked_plan", context);

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
      context.emit(state, { type: "plan_revised", version: plan.version, reason: replanReason });
      if (++replansWithoutProgress > MAX_REPLANS_WITHOUT_PROGRESS) {
        context.persistRuntime(
          state,
          "replan_thrash",
          JSON.stringify({ attempts: replansWithoutProgress, reason: replanReason }),
        );
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
    context.emit(state, { type: "model_completed", step: modelStepCount });
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
      if (!(await context.persist(completed, { type: "run_stopped", reason: "final_answer" }))) {
        return interruptedResult(completed);
      }
      await context.checkpoint(completed, context.now());
      if (context.durableFailed()) return interruptedResult(completed);
      return { status: "completed", answer, stopReason: "final_answer", state: completed };
    }

    // 同一批调用要么整体有预算，要么一个都不执行。
    if (state.budget.toolCalls + turn.toolCalls.length > state.budget.maxToolCalls) {
      return finishStop(state, "max_tool_calls", context);
    }
    if (!activeStep) return finishStop(state, "blocked_plan", context);

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

      const result = await executeToolCall({
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
      state.budget.toolCalls += 1;

      if (result.type === "waiting") {
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
      if (!result.ok) batchOk = false;

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
      });
      state.activeStepId = undefined;
      if (++replansWithoutProgress > MAX_REPLANS_WITHOUT_PROGRESS) {
        context.persistRuntime(
          state,
          "replan_thrash",
          JSON.stringify({ attempts: replansWithoutProgress, reason: progress.replanReason }),
        );
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
} {
  return {
    runId: state.runId,
    status: state.status,
    changedFiles: [...state.changedFiles],
    mutationRevision: state.mutationRevision,
    validations: state.validations.length,
    modelSteps: state.budget.modelSteps,
    toolCalls: state.budget.toolCalls,
  };
}
