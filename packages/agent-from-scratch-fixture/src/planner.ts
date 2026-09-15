import { extractJsonObject } from "./json-object.js";
import type { Model } from "./model.js";
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

/** Planner 的模型适配器：只解析结构化文本，不做状态写入。 */
export function createModelPlanCreator(model: Model): Pick<Planner, "create"> {
  return {
    async create(input) {
      const raw = await model.generate({
        instructions: [
          "You create short, executable plans for repository tasks.",
          "Return one JSON object and no Markdown fences or commentary.",
          "Use exactly this shape:",
          '{"acceptanceCriteria":[{"id":"...","description":"..."}],',
          '"steps":[{"id":"...","title":"...","dependsOn":[],',
          '"completionEvidence":"..."}]}',
          "Every step must be possible with the declared tools.",
          "Every completionEvidence must describe observable evidence (a tool observation).",
          "Prefer the fewest steps and the fewest acceptance criteria that still prove the goal.",
          "A read-only question usually needs a single step and a single acceptance criterion.",
          "Do not add extra verification steps that the declared tools cannot produce evidence for.",
        ].join("\n"),
        input: [{ role: "user", content: JSON.stringify(input) }],
      });

      let candidate: unknown;
      try {
        candidate = extractJsonObject(raw);
      } catch {
        throw new Error("planner returned invalid JSON");
      }
      validatePlan(candidate);
      return candidate;
    },
  };
}
