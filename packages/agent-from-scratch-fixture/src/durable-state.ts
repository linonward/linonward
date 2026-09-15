import type { ContextSource } from "./context.js";
import type { AgentState, DurableAgentState, ProviderCursor } from "./types.js";

/**
 * 持久化投影与反向投影单独成模块：`AgentState` 是权威状态，
 * `DurableAgentState` 只保留可序列化字段。
 *
 * 这里刻意只依赖 `types.ts` 与 `context.ts`，这样 `agent-loop.ts` 可以直接
 * 使用 `toDurableState` 写检查点，而不会产生 `recovery ↔ agent-loop` 的循环依赖。
 * `recovery.ts` 重新导出这些符号，保持既有 import 与测试不破。
 */
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
  // 深拷贝：检查点必须是一份不可变快照。否则后续对 state.plan/events/budget 的就地修改
  // 会同时改到已写入 store 的检查点，校验和随即对不上，恢复时报 no_valid_checkpoint。
  return structuredClone(durable);
}

export const CONTEXT_KINDS = [
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
