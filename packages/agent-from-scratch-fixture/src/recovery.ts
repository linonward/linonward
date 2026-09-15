import { randomUUID } from "node:crypto";

import type {
  AgentLoopEvent,
  AgentLoopOptions,
  LoopCompactionOptions,
  LoopPricing,
} from "./agent-loop.js";
import { isPersistenceFailure, runAgentLoopFromState } from "./agent-loop.js";
import { fromDurableState, toDurableState } from "./durable-state.js";
import { waitForUserInput } from "./interaction.js";
import type { FunctionCallOutput, ModelDriver } from "./model.js";
import type { Planner } from "./planner.js";
import type { ApprovalLedger, PolicyContext } from "./policy.js";
import {
  CHECKPOINT_HISTORY_LIMIT,
  CHECKPOINT_SCHEMA_VERSION,
  checkpointChecksum,
  createRunCheckpoint,
  type DurableEvent,
  type EventRecord,
  eventRecordChecksum,
  isEventRecord,
  isRunCheckpoint,
  type PersistedToolCall,
  type RunCheckpoint,
  type RunLease,
  type RunStore,
} from "./run-store.js";
import type { Sandbox } from "./sandbox.js";
import type { WriteLease } from "./tool.js";
import type { ToolRegistry } from "./tool-registry.js";
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
  sandbox?: Sandbox | undefined;
  requireSandbox?: boolean | undefined;
  validationSpecs?: ValidationSpec[] | undefined;
  /** 续跑时的压缩接线；与首次运行使用同一份配置。 */
  compaction?: LoopCompactionOptions | undefined;
  verifiers?: Record<string, ToolStateVerifier> | undefined;
  signal?: AbortSignal | undefined;
  onEvent?: ((event: AgentLoopEvent) => void) | undefined;
  /** 完整日志的工具钩子；透传给 `AgentLoopOptions.onToolCall`。 */
  onToolCall?: AgentLoopOptions["onToolCall"];
  /** 成本估算接线；透传给 `AgentLoopOptions.pricing`（缺省 → `cost=unknown`）。 */
  pricing?: LoopPricing | undefined;
}

export { CONTEXT_KINDS, fromDurableState, isContextKind, toDurableState } from "./durable-state.js";

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
      // 已消费预算必须随事件一起恢复，否则续跑会白拿一轮模型额度。
      return {
        ...(event.turn.finalText.trim().length === 0
          ? state
          : {
              ...state,
              messages: [...state.messages, { role: "assistant", content: event.turn.finalText }],
            }),
        budget: { ...state.budget, modelSteps: state.budget.modelSteps + 1 },
      };
    case "tool_intent":
      // tool_intent 就是这次调用被 Harness 准入的时刻，预算在此时计入。
      return { ...state, budget: { ...state.budget, toolCalls: state.budget.toolCalls + 1 } };
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

  // store 的 `expectedSequence` 必须来自 store 自己：内存日志里还有
  // `step_started` / `tool_batch_started` 这类只属于运行时的条目，两者序号并不共用。
  const persisted = await runtime.store.readEvents(state.runId, 0);
  await runtime.store.append({
    runId: state.runId,
    expectedSequence: (persisted.at(-1)?.sequence ?? 0) + 1,
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

/**
 * 续跑时把 lease 一并注入：Loop 会在安全边界继续 flush 事件与写检查点，
 * 写入仍然受同一把 owner/epoch 围栏保护。
 */
export function loopOptionsFromRuntime(
  state: AgentState,
  runtime: AgentRuntime,
  lease?: RunLease | undefined,
): AgentLoopOptions {
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
    sandbox: runtime.sandbox,
    requireSandbox: runtime.requireSandbox,
    clock: runtime.clock,
    signal: runtime.signal,
    onEvent: runtime.onEvent,
    onToolCall: runtime.onToolCall,
    pricing: runtime.pricing,
    compaction: runtime.compaction,
    persistence: lease ? { store: runtime.store, lease } : undefined,
  };
}

export interface ResumeAgentRunOptions {
  /**
   * 一次性调用（CLI 的 `resume` / `answer`）在返回前释放 lease。
   * 默认 `false`：长驻 worker 继续持有 lease，保持既有 fencing 语义。
   */
  releaseLeaseOnReturn?: boolean | undefined;
}

/**
 * 恢复入口：先获取新 lease、重放事件、对账 in-flight 工具，
 * 再从原预算与原计划继续。计数器不会被清零。
 */
export async function resumeAgentRun(
  runId: string,
  runtime: AgentRuntime,
  options: ResumeAgentRunOptions = {},
): Promise<AgentResult> {
  const restored = await restoreRun({
    runId,
    ownerId: randomUUID(),
    store: runtime.store,
  });

  try {
    return await resumeRestoredRun(restored, runtime);
  } finally {
    if (options.releaseLeaseOnReturn === true) {
      await runtime.store.releaseLease(restored.lease);
    }
  }
}

async function resumeRestoredRun(
  restored: RestoredRun,
  runtime: AgentRuntime,
): Promise<AgentResult> {
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

  const result = await runAgentLoopFromState(
    state,
    loopOptionsFromRuntime(state, runtime, restored.lease),
    {
      previousResponseId,
      outputs,
    },
  );

  // Loop 已经在每个停止边界写过检查点；这里只补一版 providerCursor 投影。
  // 围栏被拒时不能再写 store，也不该让恢复入口抛出非恢复错误。
  const persisted = await runtime.store.readEvents(result.state.runId, 0);
  try {
    await runtime.store.saveCheckpoint(
      createRunCheckpoint({
        state: toDurableState(result.state, canReuse ? cursor : undefined),
        throughSequence: persisted.at(-1)?.sequence ?? 0,
        now: runtime.clock.now(),
      }),
      restored.lease,
    );
  } catch (error) {
    if (!isPersistenceFailure(error)) throw error;
  }

  return result;
}
