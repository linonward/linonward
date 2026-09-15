import { randomUUID } from "node:crypto";

import { canonicalJson, sha256 } from "./checkpoint.js";
import type { ContextSource } from "./context.js";
import type {
  AcceptanceCriterion,
  AgentEvent,
  AgentEventInput,
  AgentState,
  CompactionSnapshot,
  PlanStep,
  TaskPlan,
  ValidationRecord,
} from "./types.js";

export interface ContextUsage {
  estimatedInputTokens: number;
  contextWindowTokens: number;
  reservedOutputTokens: number;
}

export interface CompactorInput {
  task: string;
  plan: TaskPlan;
  events: AgentEvent[];
  activeSkillNames: string[];
  changedFiles: string[];
}

export interface Compactor {
  compact(
    input: CompactorInput,
  ): Promise<Omit<CompactionSnapshot, "id" | "createdAt" | "checksum">>;
}

export interface CompactedContext {
  snapshot: CompactionSnapshot;
  rawTail: AgentEvent[];
}

export interface CompactionOutcome {
  compacted: boolean;
  snapshot: CompactionSnapshot | undefined;
  reason: string | undefined;
}

/** 预留输出、工具结果和意外增长空间；0.8 是 Harness 的保守策略。 */
export function shouldCompact(usage: ContextUsage): boolean {
  const usableInput = usage.contextWindowTokens - usage.reservedOutputTokens;
  const trigger = Math.floor(usableInput * 0.8);
  return usage.estimatedInputTokens >= trigger;
}

/**
 * 只有在没有未决工具调用、没有未写回结果、且运行仍然是 running 时才压缩。
 */
export function isSafeCompactionBoundary(input: {
  status: AgentState["status"];
  pendingToolCallCount: number;
  pendingOutputCount: number;
}): boolean {
  return (
    input.status === "running" && input.pendingToolCallCount === 0 && input.pendingOutputCount === 0
  );
}

export async function buildCompactionSnapshot(options: {
  state: AgentState;
  events: AgentEvent[];
  compactor: Compactor;
  now?: Date | undefined;
}): Promise<CompactionSnapshot> {
  if (!options.state.plan) throw new Error("cannot compact before plan initialization");

  const from = options.state.compaction.compactedThroughEvent + 1;
  const to = options.events.at(-1)?.sequence ?? from - 1;
  const draft = await options.compactor.compact({
    task: options.state.task,
    plan: options.state.plan,
    events: options.events.filter((event) => event.sequence >= from && event.sequence <= to),
    activeSkillNames: Object.keys(options.state.skills.activeSkills),
    changedFiles: options.state.changedFiles,
  });

  const withoutChecksum = {
    ...draft,
    id: randomUUID(),
    createdAt: (options.now ?? new Date()).toISOString(),
    sourceEventRange: { from, to },
  };

  return { ...withoutChecksum, checksum: sha256(canonicalJson(withoutChecksum)) };
}

function assertStringSetEqual(actual: string[], expected: string[], label: string): void {
  const left = [...actual].toSorted();
  const right = [...expected].toSorted();
  if (canonicalJson(left) !== canonicalJson(right)) {
    throw new Error(`${label} changed during compaction`);
  }
}

function assertCriteriaEqual(actual: AcceptanceCriterion[], expected: AcceptanceCriterion[]): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error("acceptance criteria changed during compaction");
  }
}

function assertCompletedWorkEqual(
  actual: CompactionSnapshot["completedWork"],
  steps: PlanStep[],
): void {
  const expected = steps
    .filter((step) => step.status === "completed")
    .map((step) => ({ stepId: step.id, evidence: step.evidence }));
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error("completed work changed during compaction");
  }
}

function assertValidationsEqual(actual: ValidationRecord[], expected: ValidationRecord[]): void {
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error("validation evidence changed during compaction");
  }
}

/** 确定性覆盖检查：漏项、伪造证据、空区间都直接拒绝，不能"差不多"地继续。 */
export function validateCompaction(
  snapshot: CompactionSnapshot,
  state: AgentState,
  events: AgentEvent[],
): void {
  if (snapshot.goal !== state.task) throw new Error("snapshot goal changed");
  if (!state.plan) throw new Error("cannot validate compaction without a plan");

  assertStringSetEqual(snapshot.constraints, state.constraints, "constraints");
  assertCriteriaEqual(snapshot.acceptanceCriteria, state.plan.acceptanceCriteria);
  assertCompletedWorkEqual(snapshot.completedWork, state.plan.steps);

  const pendingIds = new Set(snapshot.pendingWork.map((step) => step.stepId));
  for (const step of state.plan.steps.filter((candidate) => candidate.status !== "completed")) {
    if (!pendingIds.has(step.id)) throw new Error(`missing pending step: ${step.id}`);
  }

  for (const file of state.changedFiles) {
    if (!snapshot.changedFiles.includes(file)) throw new Error(`missing changed file: ${file}`);
  }

  assertStringSetEqual(snapshot.activeSkills, Object.keys(state.skills.activeSkills), "skills");
  assertStringSetEqual(snapshot.failedAttempts, state.failedAttempts, "failed attempts");
  assertValidationsEqual(snapshot.validationResults, state.validations);

  const unresolvedQuestions = state.pendingUserInput ? [state.pendingUserInput.question] : [];
  assertStringSetEqual(snapshot.unresolvedQuestions, unresolvedQuestions, "unresolved questions");

  for (const decision of snapshot.decisions) {
    for (const eventId of decision.evidenceEventIds) {
      const known = events.some(
        (event) =>
          event.eventId === eventId &&
          event.sequence >= snapshot.sourceEventRange.from &&
          event.sequence <= snapshot.sourceEventRange.to,
      );
      if (!known) throw new Error(`unknown evidence event: ${eventId}`);
    }
  }

  if (snapshot.sourceEventRange.to < snapshot.sourceEventRange.from) {
    throw new Error("empty compaction range");
  }
}

/**
 * 从"最近 N 条""当前 Step 开始""最后一次用户输入""最近完整工具批次开始"
 * 四个边界中选择最早者，因此 rawTail 与快照末尾有一小段有意重叠。
 */
export function selectRawTailBoundary(
  events: AgentEvent[],
  snapshot: CompactionSnapshot,
  rawTailSize: number,
): number {
  const lastN = events.at(-rawTailSize)?.sequence ?? snapshot.sourceEventRange.from;
  const candidates = [
    lastN,
    events.findLast((event) => event.type === "step_started")?.sequence,
    events.findLast((event) => event.type === "user_input")?.sequence,
    events.findLast((event) => event.type === "tool_batch_started")?.sequence,
  ].filter((sequence): sequence is number => sequence !== undefined);

  return Math.min(...candidates);
}

export function projectCompactedContext(options: {
  snapshot: CompactionSnapshot;
  events: AgentEvent[];
  rawTailSize: number;
}): CompactedContext {
  const boundary = selectRawTailBoundary(options.events, options.snapshot, options.rawTailSize);
  return {
    snapshot: options.snapshot,
    rawTail: options.events.filter((event) => event.sequence >= boundary),
  };
}

function eventAsContextSource(event: AgentEvent): ContextSource {
  return {
    id: `event:${event.sequence}`,
    kind: "tool_observation",
    label: `${event.type}@${event.sequence}`,
    content: event.detail,
    priority: 70,
  };
}

export function compactionAsContextSources(context: CompactedContext): ContextSource[] {
  return [
    {
      id: `compaction:${context.snapshot.id}`,
      kind: "compaction_snapshot",
      label: "Verified task memory",
      content: JSON.stringify(context.snapshot),
      priority: 95,
    },
    ...context.rawTail.map(eventAsContextSource),
  ];
}

/**
 * 压缩发生在"状态更新完成"与"下一轮 buildModelRequest"之间。
 * 校验失败时保留原上下文并报告原因，绝不使用"差不多"的摘要继续。
 */
export async function maybeCompactContext(options: {
  state: AgentState;
  events: AgentEvent[];
  usage: ContextUsage;
  pendingToolCallCount: number;
  pendingOutputCount: number;
  compactor: Compactor;
  emit: (event: AgentEventInput) => Promise<void>;
  now?: Date | undefined;
}): Promise<CompactionOutcome> {
  if (!shouldCompact(options.usage)) {
    return { compacted: false, snapshot: undefined, reason: "below_threshold" };
  }
  if (
    !isSafeCompactionBoundary({
      status: options.state.status,
      pendingToolCallCount: options.pendingToolCallCount,
      pendingOutputCount: options.pendingOutputCount,
    })
  ) {
    return { compacted: false, snapshot: undefined, reason: "unsafe_boundary" };
  }

  await options.emit({
    type: "compaction_started",
    through: options.events.at(-1)?.sequence ?? 0,
  });

  const snapshot = await buildCompactionSnapshot({
    state: options.state,
    events: options.events,
    compactor: options.compactor,
    now: options.now,
  });

  try {
    validateCompaction(snapshot, options.state, options.events);
  } catch (error) {
    await options.emit({
      type: "compaction_rejected",
      reason: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  options.state.compaction.snapshots.push(snapshot);
  options.state.compaction.compactedThroughEvent = snapshot.sourceEventRange.to;
  await options.emit({
    type: "compaction_completed",
    snapshotId: snapshot.id,
    sourceEventRange: snapshot.sourceEventRange,
  });

  return { compacted: true, snapshot, reason: undefined };
}
