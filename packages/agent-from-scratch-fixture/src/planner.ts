import type { ReplanReason } from "./plan.js";
import type { AcceptanceCriterion, PlanStep, TaskPlan } from "./types.js";

export interface PlanDraft {
  acceptanceCriteria: Array<{ id: string; description: string }>;
  steps: Array<{
    id: string;
    title: string;
    dependsOn: string[];
    completionEvidence: string;
  }>;
}

export interface PlanEvaluation {
  completed: boolean;
  evidence: string[];
  passedCriteria: string[];
  replanReason?: ReplanReason | undefined;
  /**
   * 规划器把不可用的模型输出**降级**（而不是静默通过）时附上的可读原因。
   * Loop 不消费它；它存在的意义是让"completed=true 但证据为空"这类降级可被观察与断言。
   */
  notes?: string[] | undefined;
}

/** Planner 是模型边界，只返回结构化候选；持久化与校验属于应用代码。 */
export interface Planner {
  create(input: { goal: string; context: string; availableTools: string[] }): Promise<PlanDraft>;
  revise(input: {
    current: TaskPlan;
    reason: ReplanReason;
    observations: string[];
  }): Promise<PlanDraft>;
  evaluate(input: {
    step: PlanStep;
    observations: string[];
    /**
     * 当前计划的验收条件。模型必须看到它们才能只引用真实存在的 criterion id，
     * 否则 `applyCriterionEvidence` 会因为计划外 id 直接抛错。旧调用方可以省略。
     */
    acceptanceCriteria?: readonly AcceptanceCriterion[] | undefined;
  }): Promise<PlanEvaluation>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAcceptanceCriterion(value: unknown): value is PlanDraft["acceptanceCriteria"][number] {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.description === "string" &&
    value.description.length > 0
  );
}

function isDraftStep(value: unknown): value is PlanDraft["steps"][number] {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.title === "string" &&
    value.title.length > 0 &&
    Array.isArray(value.dependsOn) &&
    value.dependsOn.every((dependency) => typeof dependency === "string") &&
    typeof value.completionEvidence === "string" &&
    value.completionEvidence.length > 0
  );
}

/** 确定性边界：拒绝空计划、重复 ID、未知依赖和循环依赖。 */
export function validatePlan(candidate: unknown): asserts candidate is PlanDraft {
  if (!isRecord(candidate)) throw new Error("plan must be an object");

  const { acceptanceCriteria, steps } = candidate;
  if (!Array.isArray(acceptanceCriteria) || acceptanceCriteria.length === 0) {
    throw new Error("plan requires at least one acceptance criterion");
  }
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error("plan requires at least one step");
  }
  if (!acceptanceCriteria.every(isAcceptanceCriterion)) {
    throw new Error("invalid acceptance criterion");
  }
  if (!steps.every(isDraftStep)) throw new Error("invalid plan step");

  const criterionIds = acceptanceCriteria.map((criterion) => criterion.id);
  if (new Set(criterionIds).size !== criterionIds.length) {
    throw new Error("duplicate acceptance criterion id");
  }

  const ids = steps.map((step) => step.id);
  if (new Set(ids).size !== ids.length) throw new Error("duplicate step id");

  const knownIds = new Set(ids);
  for (const step of steps) {
    if (step.dependsOn.some((dependency) => !knownIds.has(dependency))) {
      throw new Error(`unknown dependency in step: ${step.id}`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(steps.map((step) => [step.id, step]));

  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error("plan contains a dependency cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };

  for (const id of ids) visit(id);
}

/**
 * 模型给出了步骤、却把 `acceptanceCriteria` 留空时的确定性兜底。
 *
 * 规划器反复要求"至少一条验收条件"，但真实模型对寒暄、纯问答这类任务很容易返回
 * `acceptanceCriteria: []`——它认为"没有可验证的产物"。此时整次运行不该因为一条
 * 形式化的准则而失败：补一条总是可满足的准则（"给出回答"），其余契约照常校验。
 *
 * 只兜底 criteria，**不**兜底 steps：空步骤意味着模型根本没说怎么做，那仍然要报错
 * 并让调用方决定（例如换成单步短路计划）。
 */
export function withDefaultCriterion(draft: PlanDraft, goal: string): PlanDraft {
  if (draft.acceptanceCriteria.length > 0) return draft;

  const trimmed = goal.trim();
  return {
    ...draft,
    acceptanceCriteria: [
      {
        id: "answer-delivered",
        description:
          trimmed.length === 0
            ? "已针对任务给出回答，且回答有可观察依据。"
            : `已针对任务给出回答（任务：${trimmed}），且回答有可观察依据。`,
      },
    ],
  };
}

export async function createInitialPlan(
  goal: string,
  context: string,
  tools: string[],
  planner: Pick<Planner, "create">,
): Promise<TaskPlan> {
  const draft = await planner.create({ goal, context, availableTools: tools });
  validatePlan(draft);

  return {
    version: 1,
    goal,
    acceptanceCriteria: draft.acceptanceCriteria.map(
      (criterion): AcceptanceCriterion => ({ ...criterion, status: "unverified" }),
    ),
    steps: draft.steps.map((step): PlanStep => ({ ...step, status: "pending", evidence: [] })),
  };
}

/**
 * `create` 只由模型适配器（`planner-model.ts`）实现：它复用同一套"解析 → 校验 → 带错误
 * 有界重试"的契约适配器，因此不再在这里保留一份不重试的旧实现。
 */
