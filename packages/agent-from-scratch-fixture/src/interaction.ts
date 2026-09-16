import type { ContextSource } from "./context.js";
import type { ReplanReason } from "./plan.js";
import type { ApprovalLedger } from "./policy.js";
import { appendEvent, transitionState } from "./state.js";
import type { AgentState, UserInputAnswer, UserInputRequest } from "./types.js";

export function answerAsContextSource(
  request: UserInputRequest,
  answer: UserInputAnswer,
): ContextSource {
  return {
    id: `user-input:${answer.requestId}`,
    kind: "user_input",
    label: request.question,
    content: answer.content,
    priority: 98,
  };
}

/** 先落盘请求与事件，再把运行从 running 转成 waiting。 */
export function waitForUserInput(
  state: AgentState,
  request: UserInputRequest,
  now = new Date(),
): AgentState {
  if (state.pendingUserInput) throw new Error("user_input_already_pending");

  const recorded = appendEvent(
    { ...state, pendingUserInput: request },
    "user_input_requested",
    JSON.stringify(request),
    now,
  );
  return transitionState(recorded, "waiting", request.kind, now);
}

/** 未知、过期、重复或属于另一个 run 的 requestId 都会被拒绝。 */
export function applyUserAnswer(
  state: AgentState,
  answer: UserInputAnswer,
  now = new Date(),
): AgentState {
  const pending = state.pendingUserInput;
  if (!pending || pending.id !== answer.requestId) throw new Error("unexpected_user_input");
  if (!answer.content.trim()) throw new Error("empty_user_input");
  if (pending.expiresAt !== undefined && Date.parse(pending.expiresAt) <= now.getTime()) {
    throw new Error("expired_user_input");
  }

  const recorded = appendEvent(
    {
      ...state,
      pendingUserInput: undefined,
      contextSources: [...state.contextSources, answerAsContextSource(pending, answer)],
    },
    "user_input_received",
    JSON.stringify(answer),
    now,
  );
  return transitionState(recorded, "running", "user_input_received", now);
}

/**
 * 批准了一条策略审批之后，把运行从 `waiting` 拉回 `running`。
 *
 * 审批与澄清共用 `waiting`，但恢复方式不同：澄清要把回答写进上下文（`applyUserAnswer`），
 * 审批只是**放行一次已经绑定 digest 的调用**——凭证由账本发放，重放的工具调用会在
 * `consumeApprovalGrant` 时消费它。
 *
 * 必须显式走这一步，因为状态机只允许 `waiting -> running`：批准后若直接续跑、
 * 模型又提出一次审批，`waiting -> waiting` 会直接抛 `invalid state transition`。
 */
export function applyApprovalGrant(
  state: AgentState,
  requestId: string,
  now = new Date(),
): AgentState {
  if (state.status !== "waiting") throw new Error("not_waiting_for_approval");

  const recorded = appendEvent(state, "approval_granted", JSON.stringify({ requestId }), now);
  return transitionState(recorded, "running", "approval_granted", now);
}

/**
 * 批准一条待批准的请求：先发凭证，再把运行拉回 `running`。
 *
 * 顺序不能反：状态一旦回到 `running`，就意味着这次批准已经生效——凭证必须先到位，
 * 否则续跑的第一次工具调用会再次落在 `waiting` 上。
 */
export async function grantApproval(input: {
  approvals: ApprovalLedger;
  state: AgentState;
  requestId: string;
  now?: Date | undefined;
}): Promise<AgentState> {
  const now = input.now ?? new Date();
  await input.approvals.approve(input.state.runId, input.requestId, now);
  return applyApprovalGrant(input.state, input.requestId, now);
}

export type SteeringInput =
  | { kind: "answer"; answer: UserInputAnswer }
  | { kind: "constraint"; constraint: string }
  | { kind: "goal_change"; goal: string }
  | { kind: "cancel"; reason: string };

export interface SteeringOutcome {
  state: AgentState;
  replanReason: ReplanReason | undefined;
  /** 目标改变后旧批准必须失效，由调用方交给 ApprovalLedger。 */
  invalidateApprovals: boolean;
}

/**
 * 用户中途输入的分类：answer 继续、constraint 触发重规划、
 * goal_change 保存新 Goal 版本、cancel 停止运行。
 */
export function applyUserSteering(
  state: AgentState,
  input: SteeringInput,
  now = new Date(),
): SteeringOutcome {
  if (input.kind === "answer") {
    return {
      state: applyUserAnswer(state, input.answer, now),
      replanReason: undefined,
      invalidateApprovals: false,
    };
  }

  if (input.kind === "constraint") {
    if (!input.constraint.trim()) throw new Error("empty_user_constraint");
    const recorded = appendEvent(
      { ...state, constraints: [...state.constraints, input.constraint] },
      "user_constraint",
      input.constraint,
      now,
    );
    return { state: recorded, replanReason: "new_constraint", invalidateApprovals: false };
  }

  if (input.kind === "goal_change") {
    if (!input.goal.trim()) throw new Error("empty_goal_change");
    const previousPlan = state.plan;
    const revisedPlan =
      previousPlan === undefined
        ? undefined
        : {
            ...previousPlan,
            version: previousPlan.version + 1,
            goal: input.goal,
            revisionReason: "new_constraint",
            steps: previousPlan.steps.map((step) =>
              step.status === "in_progress" ? { ...step, status: "pending" as const } : step,
            ),
          };
    const recorded = appendEvent(
      {
        ...state,
        task: input.goal,
        goalVersion: state.goalVersion + 1,
        plan: revisedPlan,
        activeStepId: undefined,
        pendingUserInput: undefined,
      },
      "goal_changed",
      input.goal,
      now,
    );
    return { state: recorded, replanReason: "new_constraint", invalidateApprovals: true };
  }

  const cancelled = transitionState(state, "cancelled", input.reason, now);
  return { state: cancelled, replanReason: undefined, invalidateApprovals: false };
}
