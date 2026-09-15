import type { ContextSource } from "./context.js";
import { type PlanDraft, validatePlan } from "./planner.js";
import type { AcceptanceCriterion, PlanStep, TaskPlan } from "./types.js";

export type { PlanDraft, PlanEvaluation, Planner } from "./planner.js";
export { createInitialPlan, createModelPlanCreator, validatePlan } from "./planner.js";

export type ReplanReason =
  | "new_constraint"
  | "failed_assumption"
  | "repeated_tool_failure"
  | "no_ready_step";

function updateStep(
  plan: TaskPlan,
  stepId: string,
  update: (step: PlanStep) => PlanStep,
): TaskPlan {
  const step = plan.steps.find((candidate) => candidate.id === stepId);
  if (!step) throw new Error(`unknown plan step: ${stepId}`);

  return {
    ...plan,
    steps: plan.steps.map((candidate) => (candidate.id === stepId ? update(candidate) : candidate)),
  };
}

/** 只取依赖全部完成的第一个 `pending` Step，不需要再问模型。 */
export function selectNextStep(plan: TaskPlan): PlanStep | undefined {
  const completed = new Set(
    plan.steps.filter((step) => step.status === "completed").map((step) => step.id),
  );

  return plan.steps.find(
    (step) =>
      step.status === "pending" && step.dependsOn.every((dependency) => completed.has(dependency)),
  );
}

/** 同一时刻最多一个 `in_progress`；只有 ready 的 Step 才能启动。 */
export function startStep(plan: TaskPlan, stepId: string): TaskPlan {
  if (plan.steps.some((step) => step.status === "in_progress")) {
    throw new Error("another plan step is already in progress");
  }

  const selected = selectNextStep(plan);
  if (selected?.id !== stepId) throw new Error("step is not ready");

  return updateStep(plan, stepId, (step) => ({ ...step, status: "in_progress" }));
}

export function completeStep(plan: TaskPlan, stepId: string, evidence: string): TaskPlan {
  if (!evidence.trim()) throw new Error("completion evidence is required");

  return updateStep(plan, stepId, (step) => {
    if (step.status !== "in_progress") throw new Error("step is not in progress");
    return { ...step, status: "completed", evidence: [...step.evidence, evidence] };
  });
}

export function allCriteriaPassed(plan: TaskPlan): boolean {
  return plan.acceptanceCriteria.every((criterion) => criterion.status === "passed");
}

export function allStepsCompleted(plan: TaskPlan): boolean {
  return plan.steps.every((step) => step.status === "completed");
}

/** 先用确定性信号决定是否需要重规划，避免每轮重新生成导致的抖动。 */
export function shouldReplan(input: {
  userChangedGoal: boolean;
  failedAssumption: boolean;
  consecutiveToolFailures: number;
  plan: TaskPlan;
}): ReplanReason | undefined {
  if (input.userChangedGoal) return "new_constraint";
  if (input.failedAssumption) return "failed_assumption";
  if (input.consecutiveToolFailures >= 2) return "repeated_tool_failure";

  const unfinished = input.plan.steps.some(
    (step) => step.status === "pending" || step.status === "in_progress",
  );
  const active = input.plan.steps.some((step) => step.status === "in_progress");
  if (unfinished && !active && !selectNextStep(input.plan)) return "no_ready_step";
  return undefined;
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * 保持 Goal 原文，但只在 ID **和语义契约**都不变时继承状态。
 * 只复用 ID 会让含义已改变的新步骤错误继承 completed/passed。
 */
export function reconcilePlan(current: TaskPlan, draft: PlanDraft, reason: ReplanReason): TaskPlan {
  validatePlan(draft);

  const completedSteps = new Map(
    current.steps
      .filter((step) => step.status === "completed")
      .map((step): [string, PlanStep] => [step.id, step]),
  );

  const sameStepContract = (previous: PlanStep, next: PlanDraft["steps"][number]): boolean =>
    previous.title === next.title &&
    previous.completionEvidence === next.completionEvidence &&
    arraysEqual(previous.dependsOn, next.dependsOn);

  const sameCriterionContract = (
    previous: AcceptanceCriterion,
    next: PlanDraft["acceptanceCriteria"][number],
  ): boolean => previous.description === next.description;

  return {
    version: current.version + 1,
    goal: current.goal,
    revisionReason: reason,
    acceptanceCriteria: draft.acceptanceCriteria.map((criterion): AcceptanceCriterion => {
      const previous = current.acceptanceCriteria.find(
        (candidate) => candidate.id === criterion.id,
      );
      const canReuse = previous !== undefined && sameCriterionContract(previous, criterion);
      if (canReuse && previous.evidence !== undefined) {
        return { ...criterion, status: previous.status, evidence: previous.evidence };
      }
      return { ...criterion, status: canReuse ? previous.status : "unverified" };
    }),
    steps: draft.steps.map((step): PlanStep => {
      const completed = completedSteps.get(step.id);
      return completed !== undefined && sameStepContract(completed, step)
        ? completed
        : { ...step, status: "pending", evidence: [] };
    }),
  };
}

/** 当前版本进入 Prompt；旧版本留在审计日志中。 */
export function planAsContextSource(
  plan: TaskPlan,
  activeStep: PlanStep | undefined,
): ContextSource {
  return {
    id: `plan:${plan.version}`,
    kind: "task_plan",
    label: activeStep ? `active step: ${activeStep.id}` : "current plan",
    content: JSON.stringify({
      goal: plan.goal,
      acceptanceCriteria: plan.acceptanceCriteria,
      steps: plan.steps,
      activeStepId: activeStep?.id,
    }),
    priority: 99,
  };
}

/** 严格的“证据必须等于本轮 observation”规则，防止模型伪造来源。 */
export function assertEvidenceComesFromObservations(
  evidence: string[],
  observations: string[],
): void {
  if (evidence.some((item) => !observations.includes(item))) {
    throw new Error("planner returned evidence outside current observations");
  }
}

export function applyCriterionEvidence(
  plan: TaskPlan,
  passedCriterionIds: string[],
  observations: string[],
): TaskPlan {
  const passed = new Set(passedCriterionIds);
  for (const id of passed) {
    if (!plan.acceptanceCriteria.some((criterion) => criterion.id === id)) {
      throw new Error(`unknown acceptance criterion: ${id}`);
    }
  }

  return {
    ...plan,
    acceptanceCriteria: plan.acceptanceCriteria.map((criterion) =>
      passed.has(criterion.id)
        ? { ...criterion, status: "passed", evidence: observations.join("\n") }
        : criterion,
    ),
  };
}

/** 计划摘要的稳定格式，供 Prompt 与测试共用。 */
export function renderPlanSummary(plan: TaskPlan): string {
  const marker: Record<PlanStep["status"], string> = {
    completed: "[✓]",
    in_progress: "[→]",
    pending: "[ ]",
    blocked: "[!]",
  };
  return plan.steps.map((step) => `${marker[step.status]} ${step.id}: ${step.title}`).join("\n");
}
