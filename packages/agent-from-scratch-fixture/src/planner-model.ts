import type { Model } from "./model.js";
import type { ReplanReason } from "./plan.js";
import {
  createModelPlanCreator,
  validatePlan,
  type PlanDraft,
  type PlanEvaluation,
  type Planner,
} from "./planner.js";

/** 重规划原因的封闭集合，模型输出必须落在其中。 */
const REPLAN_REASONS: readonly ReplanReason[] = [
  "new_constraint",
  "failed_assumption",
  "repeated_tool_failure",
  "no_ready_step",
];

/** 与教程风格一致的中文契约；明确禁止 Markdown 代码围栏。 */
const PLAN_CONTRACT = [
  "你是一个仓库任务的规划器。",
  "只输出一个 JSON 对象，不要输出 Markdown 代码围栏，也不要输出任何解释文字。",
  "字段形状必须完全如下：",
  '{"acceptanceCriteria":[{"id":"...","description":"..."}],',
  '"steps":[{"id":"...","title":"...","dependsOn":[],"completionEvidence":"..."}]}',
  "acceptanceCriteria 与 steps 都不能为空；id 必须唯一；dependsOn 只能引用已声明的 step id。",
  "completionEvidence 必须描述可观察的证据（命令输出、文件内容、diff 等），不能是主观判断。",
].join("\n");

const REVISE_INSTRUCTIONS = [
  PLAN_CONTRACT,
  "",
  "现在你需要根据新的观察结果修订计划。",
  "保持目标（goal）原文不变；只调整步骤与验收条件。",
  "已完成且语义契约未变的步骤不会被回退，因此可以放心保留原有 id 与标题。",
].join("\n");

const EVALUATE_INSTRUCTIONS = [
  "你是一个仓库任务的结果评估器。",
  "只输出一个 JSON 对象，不要输出 Markdown 代码围栏，也不要输出任何解释文字。",
  "字段形状必须完全如下：",
  '{"completed":true,"evidenceIndexes":[0,2],"passedCriteria":["..."],"replanReason":null}',
  "observations 是一个字符串数组，按顺序编号，从 0 开始。",
  "evidenceIndexes 只能填 observations 里真实存在的下标，用来引用你据以判断的观测；不能编造下标，也不能改写观测内容。",
  "completed 表示当前步骤是否已经完成：只有当本轮 observations 足以证明该步骤的 completionEvidence 时才填 true，并同时给出非空的 evidenceIndexes。",
  "passedCriteria 只能填当前计划 acceptanceCriteria 里真实存在的 id。",
  "replanReason 只能取 new_constraint / failed_assumption / repeated_tool_failure / no_ready_step，不需要重规划时必须填 null。",
  "只有当计划本身已经不成立（前提被证伪、约束变化、工具反复失败、没有可执行步骤）才给出 replanReason。",
  "步骤仍在进行中、或本轮证据还不足，都不是重规划理由：此时 completed 填 false 即可，不要顺手重写计划。",
].join("\n");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label}返回了非法 JSON`);
  }
}

function isReplanReason(value: unknown): value is ReplanReason {
  return typeof value === "string" && REPLAN_REASONS.some((reason) => reason === value);
}

function parseReplanReason(value: unknown): ReplanReason | undefined {
  // `null` 是"不需要重规划"的显式写法；省略也算不重规划。
  if (value === undefined || value === null) return undefined;
  if (isReplanReason(value)) return value;
  throw new Error(`evaluate 返回了未知的 replanReason：${JSON.stringify(value)}`);
}

/**
 * 把模型的证据引用解析成 observation 原文。
 *
 * 早期实现要求模型逐字回抄 observation（判据是 `observations.includes(item)`），
 * 真实模型几乎不可能对长观测做到逐字一致，证据因此总被过滤成空、步骤永远无法完成。
 * 现在优先接受 0 基下标（模型只能从看过的观测里挑，仍然无法编造），
 * 同时保留旧的字符串字段作为兼容路径。
 */
export function resolveEvidence(
  candidate: Record<string, unknown>,
  observations: readonly string[],
): string[] {
  const indexes = candidate["evidenceIndexes"];
  if (isUnknownArray(indexes)) {
    return indexes.flatMap((value) => {
      if (typeof value !== "number" || !Number.isInteger(value)) return [];
      const picked = observations[value];
      return picked === undefined ? [] : [picked];
    });
  }
  return isStringArray(candidate["evidence"])
    ? filterEvidenceFromObservations(candidate["evidence"], observations)
    : [];
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function toEvaluation(candidate: unknown, observations: readonly string[]): PlanEvaluation {
  if (!isRecord(candidate)) throw new Error("evaluate 必须返回一个 JSON 对象");
  if (typeof candidate["completed"] !== "boolean") {
    throw new Error("evaluate 返回的 completed 必须是布尔值");
  }
  if (!isStringArray(candidate["passedCriteria"])) {
    throw new Error("evaluate 返回的 passedCriteria 必须是字符串数组");
  }

  const replanReason = parseReplanReason(candidate["replanReason"]);
  return {
    completed: candidate["completed"],
    evidence: resolveEvidence(candidate, observations),
    passedCriteria: candidate["passedCriteria"],
    ...(replanReason === undefined ? {} : { replanReason }),
  };
}

/**
 * 只保留**真实出现在本轮 observations 里**的证据字符串。
 *
 * Harness 的 `assertEvidenceComesFromObservations` 用的是 `observations.includes(item)`，
 * 判据是逐字相等。模型几乎总会把工具结果改写一遍，所以这里必须在进入 Loop 之前过滤，
 * 否则任何一次真实运行都会因"编造证据"直接停止为 `invalid_model_output`。
 */
export function filterEvidenceFromObservations(
  evidence: readonly string[],
  observations: readonly string[],
): string[] {
  return evidence.filter((item) => observations.includes(item));
}

export interface ModelPlannerOptions {
  /** 传给评估器的 observation 条数上限（取最新的一段）。 */
  maxObservations?: number | undefined;
}

/**
 * 完整 `Planner`：`create` 复用 `createModelPlanCreator`，`revise` 与 `evaluate`
 * 都是"要求模型只输出 JSON → 解析 → 校验 → 返回结构化结果"的同一种适配器。
 */
export function createModelPlanner(model: Model, options: ModelPlannerOptions = {}): Planner {
  const creator = createModelPlanCreator(model);

  return {
    create: (input) => creator.create(input),

    async revise({ current, reason, observations }): Promise<PlanDraft> {
      const raw = await model.generate({
        instructions: REVISE_INSTRUCTIONS,
        input: [
          {
            role: "user",
            content: JSON.stringify({ currentPlan: current, reason, observations }),
          },
        ],
      });

      const candidate = parseJson(raw, "revise");
      validatePlan(candidate);
      return candidate;
    },

    async evaluate({ step, observations }): Promise<PlanEvaluation> {
      const selected =
        options.maxObservations === undefined
          ? [...observations]
          : observations.slice(Math.max(0, observations.length - options.maxObservations));

      const raw = await model.generate({
        instructions: EVALUATE_INSTRUCTIONS,
        input: [{ role: "user", content: JSON.stringify({ step, observations: selected }) }],
      });

      const parsed = toEvaluation(parseJson(raw, "evaluate"), selected);
      return {
        ...parsed,
        evidence: filterEvidenceFromObservations(parsed.evidence, selected),
      };
    },
  };
}
