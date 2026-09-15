import { buildModelRequest, summarizeSources } from "./context.js";
import {
  DELETED_FILE_HASH,
  checkCompletion,
  describeMissingProgress,
  hashChangedFiles,
} from "./completion.js";
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
import {
  activeSkillContextSources,
  discoverSkills,
  skillCatalogAsContextSource,
} from "./skill-catalog.js";
import { appendEvent, canTransition, createInitialState, transitionState } from "./state.js";
import { InMemoryWriteLease, type WriteLease } from "./tool.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { TraceSink } from "./trace.js";
import type {
  AgentResult,
  AgentState,
  Clock,
  PlanStep,
  StopReason,
  ValidationRecord,
  ValidationSpec,
} from "./types.js";

export type AgentLoopEvent =
  | { type: "run_started"; runId: string }
  | { type: "model_started"; step: number }
  | { type: "model_completed"; step: number }
  | { type: "plan_revised"; version: number; reason: string }
  | { type: "run_stopped"; reason: StopReason };

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
  clock?: Clock | undefined;
  signal?: AbortSignal | undefined;
  onEvent?: ((event: AgentLoopEvent) => void) | undefined;
}

/** 续跑时由恢复器注入：上一轮的 responseId 与尚未送达模型的结果。 */
export interface AgentLoopResume {
  previousResponseId?: string | undefined;
  outputs?: FunctionCallOutput[] | undefined;
}

interface LoopContext {
  options: AgentLoopOptions;
  approvals: ApprovalLedger;
  writeLease: WriteLease;
  emit(state: AgentState, event: AgentLoopEvent): void;
  now(): Date;
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

  return { options, approvals, writeLease, emit, now: () => options.clock?.now() ?? new Date() };
}

function stop(state: AgentState, reason: StopReason, context: LoopContext): AgentResult {
  const status: AgentState["status"] =
    reason === "cancelled"
      ? "cancelled"
      : reason === "blocked_plan"
        ? "blocked"
        : reason === "approval_required" || reason === "user_input_required"
          ? "waiting"
          : "failed";

  const stopped = canTransition(state.status, status)
    ? transitionState(state, status, reason, context.now())
    : appendEvent(state, "run_stopped", reason, context.now());

  context.emit(stopped, { type: "run_stopped", reason });
  return { status: stopped.status, answer: "", stopReason: reason, state: stopped };
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

/** 新建一次运行：创建状态、发现 Skill、生成并校验初始计划。 */
export async function runAgentLoop(task: string, options: AgentLoopOptions): Promise<AgentResult> {
  const state = createInitialState(
    task,
    options.cwd,
    { maxSteps: options.maxSteps, maxToolCalls: options.maxToolCalls },
    { now: options.clock?.now() ?? new Date() },
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

  context.emit(state, { type: "run_started", runId: state.runId });

  while (state.status === "running") {
    if (options.signal?.aborted) return stop(state, "cancelled", context);
    if (state.budget.modelSteps >= state.budget.maxSteps) return stop(state, "max_steps", context);

    let plan = state.plan;
    if (!plan) return stop(state, "blocked_plan", context);

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
      } else if (plan.steps.some((step) => step.status !== "completed")) {
        return stop(state, "blocked_plan", context);
      }
    }

    const request = buildModelRequest({
      task: state.task,
      cwd: state.cwd,
      toolNames: options.tools.names(),
      sources: [
        ...state.contextSources,
        planAsContextSource(plan, activeStep),
        skillCatalogAsContextSource(state.skills.catalog),
        ...activeSkillContextSources(state.skills),
      ],
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
      return stop(state, "model_error", context);
    }

    state.steps.push({
      number: state.steps.length + 1,
      kind: "model",
      summary: turn.toolCalls.length > 0 ? "模型请求工具" : "模型返回文本",
    });
    context.emit(state, { type: "model_completed", step: modelStepCount });

    if (turn.userInputRequest && turn.toolCalls.length > 0) {
      return stop(state, "invalid_model_output", context);
    }

    if (turn.userInputRequest) {
      const waitingRequest = turn.userInputRequest;
      const waiting = waitForUserInput(state, waitingRequest, context.now());
      context.emit(waiting, { type: "run_stopped", reason: "user_input_required" });
      return { status: "waiting", answer: "", stopReason: "user_input_required", state: waiting };
    }

    if (turn.toolCalls.length === 0) {
      const answer = turn.finalText.trim();
      if (!answer) return stop(state, "invalid_model_output", context);

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
      return { status: "completed", answer, stopReason: "final_answer", state: completed };
    }

    // 同一批调用要么整体有预算，要么一个都不执行。
    if (state.budget.toolCalls + turn.toolCalls.length > state.budget.maxToolCalls) {
      return stop(state, "max_tool_calls", context);
    }
    if (!activeStep) return stop(state, "blocked_plan", context);

    const outputs: FunctionCallOutput[] = [];
    const observations: string[] = [];
    let batchOk = true;

    for (const call of turn.toolCalls) {
      if (options.signal?.aborted) return stop(state, "cancelled", context);

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
        signal: options.signal,
        now: context.now(),
        emit: (event) => {
          const recorded = appendEvent(state, event.type, JSON.stringify(event), context.now());
          state.events = recorded.events;
          state.nextEventSequence = recorded.nextEventSequence;
        },
      });
      state.budget.toolCalls += 1;

      if (result.type === "waiting") {
        const waiting = transitionState(state, "waiting", result.reason, context.now());
        context.emit(waiting, { type: "run_stopped", reason: "approval_required" });
        return { status: "waiting", answer: "", stopReason: "approval_required", state: waiting };
      }

      state.steps.push({ number: state.steps.length + 1, kind: "tool", summary: call.name });
      state.contextSources.push({
        id: call.callId,
        kind: "tool_observation",
        label: call.name,
        content: result.output,
        priority: 80,
      });
      outputs.push({ type: "function_call_output", call_id: call.callId, output: result.output });
      observations.push(result.output);

      await recordToolObservation({
        state,
        call,
        observation: result,
        specs,
      });
      if (!result.ok) batchOk = false;
    }

    consecutiveToolFailures = batchOk ? 0 : consecutiveToolFailures + 1;

    let progress: Awaited<ReturnType<Planner["evaluate"]>>;
    try {
      progress = await options.planner.evaluate({ step: activeStep, observations });
      assertEvidenceComesFromObservations(progress.evidence, observations);
      if (progress.completed && progress.evidence.join("").trim().length === 0) {
        return stop(state, "invalid_model_output", context);
      }
    } catch {
      return stop(state, "invalid_model_output", context);
    }

    plan = applyCriterionEvidence(plan, progress.passedCriteria, observations);
    if (progress.completed) {
      plan = completeStep(plan, activeStep.id, progress.evidence.join("\n"));
      state.activeStepId = undefined;
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
    }

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
