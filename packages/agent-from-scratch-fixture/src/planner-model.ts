import type { ModelMessage } from "./context.js";
import { extractJsonObject } from "./json-object.js";
import type { Model } from "./model.js";
import type { ReplanReason } from "./plan.js";
import {
  createModelPlanCreator,
  validatePlan,
  type PlanDraft,
  type PlanEvaluation,
  type Planner,
} from "./planner.js";
import type { AcceptanceCriterion } from "./types.js";

/** 供调用方直接 `import { extractJsonObject } from "./planner-model.js"`。 */
export { extractJsonObject } from "./json-object.js";

/** 重规划原因的封闭集合，模型输出必须落在其中。 */
const REPLAN_REASONS: readonly ReplanReason[] = [
  "new_constraint",
  "failed_assumption",
  "repeated_tool_failure",
  "no_ready_step",
];

/** 解析或校验失败后的最多重试次数（首次尝试之外）。有界，避免把一次坏输出放大成无限请求。 */
export const MAX_PLANNER_RETRIES = 2;

/** 与教程风格一致的中文契约；明确禁止 Markdown 代码围栏。 */
const PLAN_CONTRACT = [
  "你是一个仓库任务的规划器。",
  "只输出一个 JSON 对象，不要输出 Markdown 代码围栏，也不要输出任何解释文字。",
  "字段形状必须完全如下：",
  '{"acceptanceCriteria":[{"id":"...","description":"..."}],',
  '"steps":[{"id":"...","title":"...","dependsOn":[],"completionEvidence":"..."}]}',
  "acceptanceCriteria 与 steps 都不能为空；id 必须唯一；dependsOn 只能引用已声明的 step id。",
  "completionEvidence 必须描述可观察的证据（命令输出、文件内容、diff 等），不能是主观判断。",
  "步骤要少而可执行：能用一个步骤完成就不要拆成多个，不要为了看起来完整而添加多余步骤。",
].join("\n");

const REVISE_INSTRUCTIONS = [
  PLAN_CONTRACT,
  "",
  "现在你需要根据新的观察结果修订计划。",
  "保持目标（goal）原文不变；只调整步骤与验收条件。",
  "已完成且语义契约未变的步骤不会被回退，因此可以放心保留原有 id 与标题。",
  "如果原计划仍然有效，就原样保留步骤与验收条件，不要为了「改进」而重写。",
].join("\n");

const JSON_ONLY_REMINDER =
  "只输出一个 JSON 对象，不要输出 Markdown 代码围栏，也不要输出任何解释文字。";

const EVALUATE_INSTRUCTIONS = [
  "你是一个仓库任务的结果评估器。",
  JSON_ONLY_REMINDER,
  "字段形状必须完全如下：",
  '{"completed":true,"evidenceIndexes":[0,2],"passedCriteria":["..."],"replanReason":null}',
  "observations 是一个字符串数组，按顺序编号，从 0 开始。",
  "输入里的 completionEvidence 是「完成当前步骤需要什么证据」；你只能依据**本轮 observations** 判断，",
  "不要依据计划之外的知识、对未来的猜测或「通常应该已经完成」的直觉。",
  "判据：",
  "- 只要本轮 observations 已经足以证明 completionEvidence，就必须填 completed: true，并给出非空的 evidenceIndexes。",
  "- completed: true 时 replanReason 必须是 null。",
  "- 证据不足、或步骤还在进行中时，填 completed: false；此时 replanReason 仍然是 null。",
  "evidenceIndexes 只能填 observations 里真实存在的下标，用来引用你据以判断的观测；不能编造下标，也不能改写观测内容。",
  "passedCriteria 只能填输入里 acceptanceCriteria 中真实存在的 id；一个都不满足就填空数组。",
  "replanReason 只在计划本身已经失效时才给。",
  "正例：observations 证明「该步骤依赖的文件或命令不存在，必须换一条路径」，此时填 failed_assumption 并重写计划。",
  "反例：步骤还在进行中、或本轮证据还不足——这不是重规划理由，completed 填 false、replanReason 填 null，不要顺手重写计划。",
  "replanReason 只能取 new_constraint / failed_assumption / repeated_tool_failure / no_ready_step。",
].join("\n");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** 把解析失败统一成 `"<label>返回了非法 JSON"`，调用方与测试都依赖这个前缀。 */
function parseJson(raw: string, label: string): unknown {
  try {
    return extractJsonObject(raw);
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

function toEvaluation(
  candidate: unknown,
  observations: readonly string[],
  criteria: readonly AcceptanceCriterion[] | undefined,
): PlanEvaluation {
  if (!isRecord(candidate)) throw new Error("evaluate 必须返回一个 JSON 对象");
  if (typeof candidate["completed"] !== "boolean") {
    throw new Error("evaluate 返回的 completed 必须是布尔值");
  }
  if (!isStringArray(candidate["passedCriteria"])) {
    throw new Error("evaluate 返回的 passedCriteria 必须是字符串数组");
  }

  const notes: string[] = [];
  let completed = candidate["completed"];
  let replanReason = parseReplanReason(candidate["replanReason"]);
  let passedCriteria = candidate["passedCriteria"];
  const evidence = resolveEvidence(candidate, observations);

  // completed 与 replanReason 互斥：同时给出会让 Loop 一边完成步骤、一边重写计划并清空 activeStepId，
  // 正是"反复重规划无进展"的起点。这里以 completed 为准，丢掉矛盾的 replanReason。
  if (completed && replanReason !== undefined) {
    notes.push("completed=true 与 replanReason 互斥：已忽略 replanReason，只完成当前步骤。");
    replanReason = undefined;
  }

  // 计划外的 criterion id 会让 `applyCriterionEvidence` 直接抛错并终止整个运行，
  // 因此这里只保留输入里真实存在的 id，其余显式降级为 note。
  if (criteria !== undefined) {
    const known = new Set(criteria.map((criterion) => criterion.id));
    const unknown = passedCriteria.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      notes.push(`passedCriteria 含计划外的 id，已忽略：${unknown.join(", ")}`);
      passedCriteria = passedCriteria.filter((id) => known.has(id));
    }
  }

  // 没有可引用证据的 completed=true 对 Loop 毫无意义（会被它判成无效输出），
  // 因此降级为 completed=false 并留下可读原因，而不是静默通过。
  if (completed && evidence.length === 0) {
    notes.push(
      "completed=true 但 evidenceIndexes 为空或全部越界，已降级为 completed=false，本轮不完成步骤。",
    );
    completed = false;
    passedCriteria = [];
  }

  return {
    completed,
    evidence,
    passedCriteria,
    ...(replanReason === undefined ? {} : { replanReason }),
    ...(notes.length === 0 ? {} : { notes }),
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

interface ModelJsonRequest<T> {
  model: Model;
  instructions: string;
  payload: unknown;
  label: string;
  /** 解析 + 校验；抛出的错误就是重试时要回灌给模型的"上一次的错误"。 */
  parse: (raw: string) => T;
}

function describeError(error: unknown, label: string): Error {
  if (error instanceof Error) return error;
  return new Error(`${label}返回了非法 JSON`);
}

function retryMessage(previous: Error): string {
  return [`上一次的回复不符合契约：${previous.message}`, JSON_ONLY_REMINDER].join("\n");
}

/**
 * "要 JSON → 解析校验 → 失败就带着上一次的错误再问一次"的有界循环。
 *
 * 最多请求 `1 + MAX_PLANNER_RETRIES` 次：真实模型偶发围栏/解释文字，
 * 一次带错误信息的追问通常就能纠正；再多只是浪费额度。
 * 如果重试请求本身失败（网络/额度），不再重试，并把首次的契约错误保留在消息里。
 */
async function requestModelJson<T>(request: ModelJsonRequest<T>): Promise<T> {
  const base: ModelMessage[] = [{ role: "user", content: JSON.stringify(request.payload) }];
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_PLANNER_RETRIES; attempt += 1) {
    const input: ModelMessage[] =
      lastError === undefined
        ? [...base]
        : [...base, { role: "user", content: retryMessage(lastError) }];

    let raw: string;
    try {
      raw = await request.model.generate({ instructions: request.instructions, input });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (lastError === undefined) throw error;
      throw new Error(`${lastError.message}；重试时模型调用失败：${reason}`);
    }

    try {
      return request.parse(raw);
    } catch (error) {
      lastError = describeError(error, request.label);
    }
  }

  throw lastError ?? new Error(`${request.label}返回了非法 JSON`);
}

/**
 * 完整 `Planner`：`create` 复用 `createModelPlanCreator`，`revise` 与 `evaluate`
 * 都是"要求模型只输出 JSON → 解析 → 校验 → 带错误重试"的同一种适配器。
 */
export function createModelPlanner(model: Model, options: ModelPlannerOptions = {}): Planner {
  const creator = createModelPlanCreator(model);

  return {
    create: (input) => creator.create(input),

    async revise({ current, reason, observations }): Promise<PlanDraft> {
      return requestModelJson({
        model,
        instructions: REVISE_INSTRUCTIONS,
        payload: { currentPlan: current, reason, observations },
        label: "revise",
        parse: (raw) => {
          const candidate = parseJson(raw, "revise");
          validatePlan(candidate);
          return candidate;
        },
      });
    },

    async evaluate({ step, observations, acceptanceCriteria }): Promise<PlanEvaluation> {
      const selected =
        options.maxObservations === undefined
          ? [...observations]
          : observations.slice(Math.max(0, observations.length - options.maxObservations));

      const payload: Record<string, unknown> = {
        step,
        // 显式提升为顶层字段：模型必须看到"完成这一步需要什么证据"才能判断 completed。
        completionEvidence: step.completionEvidence,
        observations: selected,
      };
      if (acceptanceCriteria !== undefined) {
        payload["acceptanceCriteria"] = acceptanceCriteria.map((criterion) => ({
          id: criterion.id,
          description: criterion.description,
        }));
      }

      return requestModelJson({
        model,
        instructions: EVALUATE_INSTRUCTIONS,
        payload,
        label: "evaluate",
        parse: (raw) => toEvaluation(parseJson(raw, "evaluate"), selected, acceptanceCriteria),
      });
    },
  };
}
