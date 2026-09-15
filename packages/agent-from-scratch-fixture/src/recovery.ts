import { randomUUID } from "node:crypto";

import type { AgentLoopEvent, AgentLoopOptions } from "./agent-loop.js";
import { runAgentLoopFromState } from "./agent-loop.js";
import type { ContextSource } from "./context.js";
import { waitForUserInput } from "./interaction.js";
import type { FunctionCallOutput, ModelDriver } from "./model.js";
import type { Planner } from "./planner.js";
import type { ApprovalLedger, PolicyContext } from "./policy.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { WriteLease } from "./tool.js";
import type { TraceSink } from "./trace.js";
import type {
  AgentResult,
  AgentState,
  Clock,
  DurableAgentState,
  ProviderCursor,
  StopReason,
  UserInputRequest,
  ValidationSpec,
} from "./types.js";
import {
  CHECKPOINT_HISTORY_LIMIT,
  CHECKPOINT_SCHEMA_VERSION,
  checkpointChecksum,
  createRunCheckpoint,
  eventRecordChecksum,
  isEventRecord,
  isRunCheckpoint,
  type DurableEvent,
  type EventRecord,
  type PersistedToolCall,
  type RunCheckpoint,
  type RunLease,
  type RunStore,
} from "./run-store.js";

/** 工具声明自己的恢复策略；未知调用绝不能因为"多数时候没事"就标记完成。 */
export interface ToolStateVerifier {
  verify(input: {
    call: PersistedToolCall;
    state: DurableAgentState;
  }): Promise<{ status: "applied"; output: string } | { status: "not_applied" }>;
}

export type RecoveryPolicy =
  | { kind: "replay_safe" }
  | { kind: "idempotent"; keyLocation: "header" | "argument" }
  | { kind: "verify_then_continue"; verify: ToolStateVerifier }
  | { kind: "manual_reconciliation" };

export interface AgentRuntime {
  model: ModelDriver & {
    canResume?(cursor: ProviderCursor | undefined): Promise<boolean>;
  };
  planner: Planner;
  tools: ToolRegistry;
  trace: TraceSink;
  store: RunStore;
  clock: Clock;
  skillsDirectory: string;
  toolTimeoutMs: number;
  policy?: PolicyContext | undefined;
  approvals?: ApprovalLedger | undefined;
  writeLease?: WriteLease | undefined;
  validationSpecs?: ValidationSpec[] | undefined;
  verifiers?: Record<string, ToolStateVerifier> | undefined;
  signal?: AbortSignal | undefined;
  onEvent?: ((event: AgentLoopEvent) => void) | undefined;
}

export function toDurableState(
  state: AgentState,
  providerCursor?: ProviderCursor | undefined,
): DurableAgentState {
  if (!state.plan) throw new Error("cannot persist a run without a plan");

  const durable: DurableAgentState = {
    runId: state.runId,
    task: state.task,
    cwd: state.cwd,
    status: state.status,
    plan: state.plan,
    planHistory: state.planHistory,
    messages: state.messages,
    contextSources: state.contextSources.map((source) => ({
      id: source.id,
      kind: source.kind,
      label: source.label,
      content: source.content,
      priority: source.priority,
    })),
    skills: state.skills,
    compaction: state.compaction,
    changedFiles: state.changedFiles,
    changedFileHashes: state.changedFileHashes,
    mutationRevision: state.mutationRevision,
    validations: state.validations,
    requiredCriterionIds: state.requiredCriterionIds,
    budget: state.budget,
    goalVersion: state.goalVersion,
    constraints: state.constraints,
    failedAttempts: state.failedAttempts,
    events: state.events,
    nextEventSequence: state.nextEventSequence,
    stopReason: state.stopReason,
  };
  if (state.activeStepId !== undefined) durable.activeStepId = state.activeStepId;
  if (state.pendingUserInput !== undefined) durable.pendingUserInput = state.pendingUserInput;
  if (providerCursor !== undefined) durable.providerCursor = providerCursor;
  return durable;
}

const CONTEXT_KINDS = [
  "workspace_rule",
  "file_excerpt",
  "tool_observation",
  "conversation_summary",
  "task_plan",
  "user_input",
  "skill_catalog",
  "skill_instructions",
  "skill_resource",
  "compaction_snapshot",
  "harness_feedback",
] as const satisfies readonly ContextSource["kind"][];

export function isContextKind(value: unknown): value is ContextSource["kind"] {
  return typeof value === "string" && (CONTEXT_KINDS as readonly string[]).includes(value);
}

export function fromDurableState(durable: DurableAgentState): AgentState {
  const contextSources: ContextSource[] = durable.contextSources.flatMap((source) =>
    isContextKind(source.kind) ? [{ ...source, kind: source.kind }] : [],
  );

  return {
    runId: durable.runId,
    task: durable.task,
    cwd: durable.cwd,
    status: durable.status,
    messages: durable.messages,
    contextSources,
    steps: [],
    changedFiles: durable.changedFiles,
    changedFileHashes: durable.changedFileHashes,
    mutationRevision: durable.mutationRevision,
    validations: durable.validations,
    requiredCriterionIds: durable.requiredCriterionIds,
    failedAttempts: durable.failedAttempts,
    budget: durable.budget,
    events: durable.events,
    nextEventSequence: durable.nextEventSequence,
    stopReason: durable.stopReason,
    plan: durable.plan,
    activeStepId: durable.activeStepId,
    planHistory: durable.planHistory,
    pendingUserInput: durable.pendingUserInput,
    goalVersion: durable.goalVersion,
    constraints: durable.constraints,
    skills: durable.skills,
    compaction: durable.compaction,
  };
}

function statusForStopReason(reason: StopReason): AgentState["status"] {
  if (reason === "cancelled") return "cancelled";
  if (reason === "blocked_plan") return "blocked";
  if (reason === "approval_required" || reason === "user_input_required") return "waiting";
  return "failed";
}

/** 纯函数事件 reducer：同一 checkpoint 与事件序列重复执行结果必须完全一致。 */
export function reduceDurableEvent(
  state: DurableAgentState,
  event: DurableEvent,
): DurableAgentState {
  switch (event.type) {
    case "run_started":
      return state;
    case "plan_updated":
      return { ...state, plan: event.plan };
    case "model_completed":
      return event.turn.finalText.trim().length === 0
        ? state
        : {
            ...state,
            messages: [...state.messages, { role: "assistant", content: event.turn.finalText }],
          };
    case "tool_intent":
      return state;
    case "tool_result":
      return {
        ...state,
        contextSources: [
          ...state.contextSources,
          {
            id: event.callId,
            kind: "tool_observation",
            label: event.callId,
            content: event.output,
            priority: 80,
          },
        ],
      };
    case "compaction_completed":
      return {
        ...state,
        compaction: {
          ...state.compaction,
          snapshots: [...state.compaction.snapshots, event.snapshot],
          compactedThroughEvent: event.snapshot.sourceEventRange.to,
        },
      };
    case "run_waiting":
      return { ...state, status: "waiting", stopReason: event.reason };
    case "user_input_received":
      return state;
    case "run_stopped":
      return { ...state, status: statusForStopReason(event.reason), stopReason: event.reason };
    default:
      return state;
  }
}

/** 从完整事件历史计算未配对的 `tool_intent`，不会漏掉已进入 checkpoint 的调用。 */
export function findToolIntentsWithoutResults(records: EventRecord[]): PersistedToolCall[] {
  const ordered = records.toSorted((left, right) => left.sequence - right.sequence);
  const intents = new Map<string, PersistedToolCall>();
  const resolved = new Set<string>();

  for (const record of ordered) {
    if (record.event.type === "tool_intent") {
      intents.set(record.event.call.callId, record.event.call);
    } else if (record.event.type === "tool_result") {
      resolved.add(record.event.callId);
    }
  }

  return [...intents.entries()].filter(([callId]) => !resolved.has(callId)).map(([, call]) => call);
}

export function verifyEventChecksum(record: EventRecord): void {
  const { checksum, ...rest } = record;
  if (eventRecordChecksum(rest) !== checksum) throw new Error("event_checksum_mismatch");
}

export function verifyCheckpointChecksum(checkpoint: RunCheckpoint): boolean {
  const { checksum, ...rest } = checkpoint;
  return checkpointChecksum(rest) === checksum;
}

export function assertContiguousSequences(records: EventRecord[], expectedStart: number): void {
  for (const [index, record] of records.entries()) {
    if (record.sequence !== expectedStart + index) {
      throw new Error(
        `event_sequence_gap: expected ${expectedStart + index}, got ${record.sequence}`,
      );
    }
  }
}

export function migrateCheckpoint(checkpoint: RunCheckpoint): RunCheckpoint {
  if (checkpoint.schemaVersion !== CHECKPOINT_SCHEMA_VERSION) {
    throw new Error(`unsupported_checkpoint_schema: ${String(checkpoint.schemaVersion)}`);
  }
  return checkpoint;
}

/** 从新到旧选择第一份 checksum 与 schema 都有效的 checkpoint。 */
export function firstValidCheckpoint(history: RunCheckpoint[]): RunCheckpoint | undefined {
  for (const candidate of history) {
    if (candidate.schemaVersion !== CHECKPOINT_SCHEMA_VERSION) continue;
    if (!isRunCheckpoint(candidate)) continue;
    if (!verifyCheckpointChecksum(candidate)) continue;
    return migrateCheckpoint(candidate);
  }
  return undefined;
}

export interface RestoredRun {
  state: DurableAgentState;
  lease: RunLease;
  inFlight: PersistedToolCall[];
}

export async function restoreRun(options: {
  runId: string;
  ownerId: string;
  store: RunStore;
  leaseTtlMs?: number | undefined;
}): Promise<RestoredRun> {
  const lease = await options.store.acquireLease(
    options.runId,
    options.ownerId,
    options.leaseTtlMs ?? 30_000,
  );

  const history = await options.store.loadCheckpointHistory(
    options.runId,
    CHECKPOINT_HISTORY_LIMIT,
  );
  const checkpoint = firstValidCheckpoint(history);
  if (!checkpoint) throw new Error("no_valid_checkpoint");

  let state = migrateCheckpoint(checkpoint).state;
  const records = await options.store.readEvents(options.runId, checkpoint.throughSequence);
  assertContiguousSequences(records, checkpoint.throughSequence + 1);

  for (const record of records) {
    verifyEventChecksum(record);
    state = reduceDurableEvent(state, record.event);
  }

  const all = await options.store.readEvents(options.runId, 0);
  if (!all.every(isEventRecord)) throw new Error("corrupt_event_log");

  return { state, lease, inFlight: findToolIntentsWithoutResults(all) };
}

export type ReconciliationResult =
  | { type: "resolved"; output: string }
  | { type: "manual_reconciliation"; reason: string };

/**
 * 已经执行成功、但 observation 尚未落盘的工具调用必须先对账。
 * 有 verifier 且确认已生效时只补写 `tool_result`，绝不重复执行副作用。
 */
export async function reconcileInFlightTool(
  call: PersistedToolCall,
  state: DurableAgentState,
  runtime: AgentRuntime,
  lease: RunLease,
): Promise<ReconciliationResult> {
  const idempotencyKey = `${state.runId}:${call.callId}`;
  const verifier = runtime.verifiers?.[call.name];
  if (!verifier) {
    return {
      type: "manual_reconciliation",
      reason: `no verifier registered for in-flight tool ${call.name}`,
    };
  }

  const verified = await verifier.verify({ call, state });
  const output =
    verified.status === "applied"
      ? verified.output
      : JSON.stringify({ ok: false, error: "tool_not_applied", callId: call.callId });

  await runtime.store.append({
    runId: state.runId,
    expectedSequence: state.nextEventSequence,
    ownerId: lease.ownerId,
    epoch: lease.epoch,
    event: { type: "tool_result", callId: call.callId, idempotencyKey, output },
    now: runtime.clock.now(),
  });

  state.nextEventSequence += 1;
  state.events = [
    ...state.events,
    {
      eventId: randomUUID(),
      sequence: state.nextEventSequence - 1,
      recordedAt: runtime.clock.now().toISOString(),
      type: "tool_result",
      detail: output,
    },
  ];

  return { type: "resolved", output };
}

function manualReconciliationRequest(
  call: PersistedToolCall,
  reason: string,
  now: Date,
): UserInputRequest {
  return {
    id: randomUUID(),
    kind: "manual_reconciliation",
    question: `请人工核对未完成的工具调用 ${call.name}（${call.callId}）是否已经产生副作用。`,
    reason,
    createdAt: now.toISOString(),
  };
}

export function loopOptionsFromRuntime(state: AgentState, runtime: AgentRuntime): AgentLoopOptions {
  return {
    cwd: state.cwd,
    skillsDirectory: runtime.skillsDirectory,
    maxSteps: state.budget.maxSteps,
    maxToolCalls: state.budget.maxToolCalls,
    toolTimeoutMs: runtime.toolTimeoutMs,
    model: runtime.model,
    planner: runtime.planner,
    tools: runtime.tools,
    trace: runtime.trace,
    validationSpecs: runtime.validationSpecs,
    policy: runtime.policy,
    approvals: runtime.approvals,
    writeLease: runtime.writeLease,
    clock: runtime.clock,
    signal: runtime.signal,
    onEvent: runtime.onEvent,
  };
}

/**
 * 恢复入口：先获取新 lease、重放事件、对账 in-flight 工具，
 * 再从原预算与原计划继续。计数器不会被清零。
 */
export async function resumeAgentRun(runId: string, runtime: AgentRuntime): Promise<AgentResult> {
  const restored = await restoreRun({
    runId,
    ownerId: randomUUID(),
    store: runtime.store,
  });

  let state = fromDurableState(restored.state);
  const outputs: FunctionCallOutput[] = [];

  for (const call of restored.inFlight) {
    const reconciled = await reconcileInFlightTool(call, restored.state, runtime, restored.lease);
    if (reconciled.type === "manual_reconciliation") {
      const waiting = waitForUserInput(
        state,
        manualReconciliationRequest(call, reconciled.reason, runtime.clock.now()),
        runtime.clock.now(),
      );
      state = waiting;
      return {
        status: waiting.status,
        answer: "",
        stopReason: "interrupted",
        state: waiting,
      };
    }
    outputs.push({ type: "function_call_output", call_id: call.callId, output: reconciled.output });
  }

  const cursor = restored.state.providerCursor;
  const canReuse =
    cursor === undefined
      ? false
      : runtime.model.canResume
        ? await runtime.model.canResume(cursor)
        : true;

  const previousResponseId = canReuse ? cursor?.previousResponseId : undefined;

  const result = await runAgentLoopFromState(state, loopOptionsFromRuntime(state, runtime), {
    previousResponseId,
    outputs,
  });

  const persisted = await runtime.store.readEvents(result.state.runId, 0);
  await runtime.store.saveCheckpoint(
    createRunCheckpoint({
      state: toDurableState(result.state, canReuse ? cursor : undefined),
      throughSequence: persisted.at(-1)?.sequence ?? 0,
      now: runtime.clock.now(),
    }),
    restored.lease,
  );

  return result;
}
