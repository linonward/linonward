import { randomUUID } from "node:crypto";

import { emptyUsage } from "./trace.js";
import type { AgentState } from "./types.js";

/**
 * 状态机只管理运行生命周期。计划步骤状态不能反向覆盖运行状态。
 * `waiting` 表示可由批准或用户回答恢复；`blocked` 表示策略或环境已确定拒绝。
 */
export const allowedTransitions: Record<AgentState["status"], AgentState["status"][]> = {
  running: ["waiting", "completed", "failed", "blocked", "cancelled"],
  waiting: ["running", "failed", "cancelled"],
  blocked: [],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canTransition(from: AgentState["status"], to: AgentState["status"]): boolean {
  return allowedTransitions[from].includes(to);
}

export interface InitialStateLimits {
  maxSteps: number;
  maxToolCalls: number;
  /** 花费上限（美元）。缺省不限制：只有调用方显式设了才写进 budget。 */
  maxCostUsd?: number | undefined;
  /** 墙钟上限（毫秒）。缺省不限制。 */
  maxWallMs?: number | undefined;
}

export interface InitialStateOptions {
  runId?: string | undefined;
  now?: Date | undefined;
}

export function createInitialState(
  task: string,
  cwd: string,
  limits: InitialStateLimits = { maxSteps: 12, maxToolCalls: 24 },
  options: InitialStateOptions = {},
): AgentState {
  const now = options.now ?? new Date();

  return {
    runId: options.runId ?? randomUUID(),
    task,
    cwd,
    status: "running",
    messages: [{ role: "user", content: task }],
    contextSources: [],
    steps: [],
    changedFiles: [],
    changedFileHashes: {},
    mutationRevision: 0,
    validations: [],
    requiredCriterionIds: [],
    failedAttempts: [],
    budget: {
      maxSteps: limits.maxSteps,
      maxToolCalls: limits.maxToolCalls,
      modelSteps: 0,
      toolCalls: 0,
      ...(limits.maxCostUsd !== undefined ? { maxCostUsd: limits.maxCostUsd } : {}),
      ...(limits.maxWallMs !== undefined ? { maxWallMs: limits.maxWallMs } : {}),
    },
    events: [
      {
        eventId: randomUUID(),
        sequence: 1,
        recordedAt: now.toISOString(),
        type: "run_started",
        detail: task,
      },
    ],
    nextEventSequence: 2,
    stopReason: undefined,
    plan: undefined,
    activeStepId: undefined,
    planHistory: [],
    pendingUserInput: undefined,
    goalVersion: 1,
    constraints: [],
    skills: { catalog: [], activeSkills: {} },
    compaction: { snapshots: [], compactedThroughEvent: 0 },
    usage: emptyUsage(),
  };
}

/** 事件 sequence 严格递增；返回值是新对象，调用方不能就地改写历史。 */
export function appendEvent(
  state: AgentState,
  type: string,
  detail: string,
  now = new Date(),
): AgentState {
  return {
    ...state,
    events: [
      ...state.events,
      {
        eventId: randomUUID(),
        sequence: state.nextEventSequence,
        recordedAt: now.toISOString(),
        type,
        detail,
      },
    ],
    nextEventSequence: state.nextEventSequence + 1,
  };
}

export function assertValidTransition(
  state: AgentState,
  next: AgentState["status"],
  reason: string,
): void {
  if (!canTransition(state.status, next)) {
    throw new Error(`invalid state transition: ${state.status} -> ${next}`);
  }
  if (next !== "running" && !reason.trim()) {
    throw new Error("state transition requires a reason");
  }
}

export function transitionState(
  state: AgentState,
  next: AgentState["status"],
  reason: string,
  now = new Date(),
): AgentState {
  assertValidTransition(state, next, reason);

  return appendEvent(
    {
      ...state,
      status: next,
      stopReason: next === "running" ? undefined : reason,
    },
    "status_changed",
    `${state.status} -> ${next}: ${reason}`,
    now,
  );
}
