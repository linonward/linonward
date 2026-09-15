import type { AgentLoopEvent, PlanRevisedDetail } from "./agent-loop.js";
import { formatCostUsd } from "./pricing.js";
import { formatUsageNumber } from "./trace.js";
import type { AgentResult, AgentState } from "./types.js";

/**
 * `--verbose` 的**有界**详情输出：单条详情与列表长度都有上限，
 * 无论 observation 或事件序列多长，都不会把上下文和终端刷爆。
 */
export const MAX_VERBOSE_DETAIL_CHARACTERS = 200;
/** 工具失败原因的独立上限：比通用详情更短（一行里已经有 preview）。 */
export const MAX_VERBOSE_REASON_CHARACTERS = 120;
/** 最多打印多少条工具观测；更早的观测折叠成一行提示。 */
export const MAX_VERBOSE_TOOL_OBSERVATIONS = 20;
/** 汇总里的 changedFiles / trace 序列最多列出多少项。 */
export const MAX_VERBOSE_LIST_ITEMS = 20;

export interface VerboseObserver {
  onEvent(event: AgentLoopEvent): void;
  finish(result: AgentResult): void;
}

/** 压成单行再截断：verbose 的每一行都必须有界。 */
export function truncateVerboseDetail(
  text: string,
  limit: number = MAX_VERBOSE_DETAIL_CHARACTERS,
): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length <= limit ? singleLine : `${singleLine.slice(0, limit)}...`;
}

/** 有界 id 列表：逐项截断 + 最多 `MAX_VERBOSE_LIST_ITEMS` 项，再补上因上限省略的条数。 */
function boundedIds(ids: readonly string[], omitted: number): string {
  const shown = ids.slice(0, MAX_VERBOSE_LIST_ITEMS).map((id) => truncateVerboseDetail(id));
  const rest = omitted + (ids.length - shown.length);
  const body = shown.length === 0 ? "(none)" : shown.join(",");
  return rest > 0 ? `${body}…(+${rest})` : body;
}

/**
 * `plan_revised` 的有界详情后缀：为什么改（reason 在事件前缀里）、改了什么
 * （新增/删除/改名的步骤 id 与依赖变化数）、以及触发它的最近失败工具。
 */
function planRevisedDetailSuffix(detail: PlanRevisedDetail | undefined): string {
  if (detail === undefined) return "";

  const failures = detail.recentFailures.map((failure) =>
    failure.errorCode === undefined ? failure.name : `${failure.name}:${failure.errorCode}`,
  );

  return [
    `added=${boundedIds(detail.addedSteps, detail.addedStepsOmitted)}`,
    `removed=${boundedIds(detail.removedSteps, detail.removedStepsOmitted)}`,
    `renamed=${boundedIds(detail.renamedSteps, detail.renamedStepsOmitted)}`,
    `dependsChanged=${detail.dependencyChanges}`,
    `failed=${boundedIds(failures, detail.recentFailuresOmitted)}`,
  ].join(" ");
}

/** 每个 Loop 事件一行，只带该类型的关键字段（字段本身也走截断）。 */
function eventDetail(event: AgentLoopEvent): string {
  switch (event.type) {
    case "run_started":
      return `runId=${event.runId}`;
    case "model_started":
    case "model_completed":
      return `step=${event.step}`;
    case "plan_revised":
      return [
        `version=${event.version}`,
        `reason=${event.reason}`,
        planRevisedDetailSuffix(event.detail),
      ]
        .filter((part) => part.length > 0)
        .join(" ");
    case "run_stopped":
      return `reason=${event.reason}`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** observation 是 JSON 文本；解析不出来时 ok 记为未知，而不是猜一个值。 */
interface ObservationSummary {
  ok: boolean | undefined;
  error?: string | undefined;
  reason?: string | undefined;
}

function observationSummary(content: string): ObservationSummary {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: undefined };
  }
  if (!isRecord(parsed)) return { ok: undefined };

  const rawOk = parsed["ok"];
  const summary: ObservationSummary = { ok: typeof rawOk === "boolean" ? rawOk : undefined };
  const error = parsed["error"];
  if (typeof error === "string" && error.length > 0) summary.error = error;
  const message = parsed["message"];
  if (typeof message === "string" && message.trim().length > 0) summary.reason = message;
  return summary;
}

/** 列表有界：逐项截断 + 最多 `MAX_VERBOSE_LIST_ITEMS` 项，其余折叠成 `(+n more)`。 */
function boundedList(items: readonly string[], total: number = items.length): string {
  const shown = items.slice(0, MAX_VERBOSE_LIST_ITEMS).map((item) => truncateVerboseDetail(item));
  if (shown.length === 0) return "(none)";

  const omitted = total - shown.length;
  const body = shown.join(",");
  return omitted > 0 ? `${body},(+${omitted} more)` : body;
}

/** `plan_blocked` 事件 detail 的稳定投影；字段缺失时返回 `undefined`，绝不猜一个值。 */
interface PlanBlockedSummary {
  reason: string;
  summary: string;
  activeStepId?: string | undefined;
  pendingSteps: Array<{ id: string; status: string; unmetDependencies: string[] }>;
  pendingStepsOmitted: number;
}

const PLAN_BLOCKED_REASON_LABELS: Record<string, string> = {
  missing_plan: "missing plan",
  no_ready_step: "no ready step",
  no_active_step: "no active step",
  replan_thrash: "replan thrash",
};

function toPendingStep(value: unknown): PlanBlockedSummary["pendingSteps"][number] | undefined {
  if (!isRecord(value)) return undefined;
  const id = value["id"];
  const status = value["status"];
  if (typeof id !== "string" || typeof status !== "string") return undefined;

  const unmet = value["unmetDependencies"];
  return {
    id,
    status,
    unmetDependencies: Array.isArray(unmet)
      ? unmet.filter((dependency): dependency is string => typeof dependency === "string")
      : [],
  };
}

/** 从 `state.events` 里取最后一条 `plan_blocked`：这是 Loop 在停止前登记的阻塞原因。 */
function readPlanBlocked(state: AgentState): PlanBlockedSummary | undefined {
  const event = [...state.events].reverse().find((candidate) => candidate.type === "plan_blocked");
  if (event === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(event.detail);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;

  const reason = parsed["reason"];
  const summary = parsed["summary"];
  if (typeof reason !== "string" || typeof summary !== "string") return undefined;

  const rawPending = parsed["pendingSteps"];
  const omitted = parsed["pendingStepsOmitted"];
  const activeStepId = parsed["activeStepId"];
  const result: PlanBlockedSummary = {
    reason,
    summary,
    pendingSteps: Array.isArray(rawPending)
      ? rawPending.flatMap((candidate) => {
          const step = toPendingStep(candidate);
          return step === undefined ? [] : [step];
        })
      : [],
    pendingStepsOmitted: typeof omitted === "number" ? omitted : 0,
  };
  if (typeof activeStepId === "string") result.activeStepId = activeStepId;
  return result;
}

/**
 * `blocked_plan` 的停止原因必须出现在汇总里：操作者要能直接看到"哪个步骤卡住、
 * 缺哪个依赖"，而不是从事件流里反推。沿用 200 字符截断与 20 项上限。
 */
export function planBlockedSummaryLines(result: AgentResult): string[] {
  if (result.stopReason !== "blocked_plan") return [];

  const detail = readPlanBlocked(result.state);
  if (detail === undefined) return ["[summary] blocked: reason unavailable"];

  const label = PLAN_BLOCKED_REASON_LABELS[detail.reason] ?? detail.reason;
  const pending = detail.pendingSteps.map(
    (step) => `${step.id}(status=${step.status}, unmet=[${step.unmetDependencies.join(",")}])`,
  );
  const pendingText = boundedList(pending, pending.length + detail.pendingStepsOmitted);
  const active = detail.activeStepId === undefined ? "" : ` active=${detail.activeStepId}`;

  return [
    `[summary] blocked: ${label} (${detail.reason}); pending=${pendingText}${active}`,
    `[summary] blocked detail: ${truncateVerboseDetail(detail.summary)}`,
  ];
}

/**
 * 工具观测摘要取自最终结果的 `state.contextSources`（`kind: "tool_observation"`），
 * 而不是 `state.steps`：只有前者同时带着 callId、工具名/标签与完整输出，才够推出
 * ok 与长度/预览；`state.steps` 里的工具条目只有名字，给不出结果状态。
 * `contextSources` 是逐检查点持久化的权威状态，同一 callId 只登记一次，重放不会重复。
 *
 * 失败时补上 `error=<code>` 与截断后的可读原因：只写 `ok=false` 没法回答"为什么失败"。
 */
function toolObservationLines(state: AgentState): string[] {
  const sources = state.contextSources.filter((source) => source.kind === "tool_observation");
  const recent = sources.slice(-MAX_VERBOSE_TOOL_OBSERVATIONS);

  const lines = recent.map((source) => {
    const observation = observationSummary(source.content);
    const fields = [
      `[tool] ${source.label}`,
      `callId=${source.id}`,
      observation.ok === undefined ? "ok=unknown" : `ok=${String(observation.ok)}`,
      ...(observation.ok === false && observation.error !== undefined
        ? [`error=${observation.error}`]
        : []),
      ...(observation.ok === false && observation.reason !== undefined
        ? [`reason=${truncateVerboseDetail(observation.reason, MAX_VERBOSE_REASON_CHARACTERS)}`]
        : []),
      `chars=${source.content.length}`,
      `preview=${truncateVerboseDetail(source.content)}`,
    ];
    return fields.join(" ");
  });

  const omitted = sources.length - recent.length;
  if (omitted > 0) lines.unshift(`[verbose] omitted ${omitted} earlier observation(s)`);
  return lines;
}

/**
 * 用量汇总行。token 缺失就是 `unknown`（不是 0），成本算不出来就是 `cost=unknown`
 * （不是 `$0.000000`）——见 `src/pricing.ts`。
 */
function usageSummaryLine(state: AgentState): string {
  const { usage } = state;
  return [
    "[summary] usage",
    `modelCalls=${usage.modelCalls}`,
    `toolCalls=${usage.toolCalls}`,
    `in=${formatUsageNumber(usage.inputTokens)}`,
    `out=${formatUsageNumber(usage.outputTokens)}`,
    `cached=${formatUsageNumber(usage.cachedInputTokens)}`,
    `wallMs=${usage.durationMs}`,
    `cost=${formatCostUsd(usage.estimatedCostUsd)}`,
  ].join(" ");
}

function summaryLines(
  result: AgentResult,
  trace: { types: readonly string[]; total: number },
): string[] {
  const { state } = result;
  const budget = [
    `modelSteps=${state.budget.modelSteps}/${state.budget.maxSteps}`,
    `toolCalls=${state.budget.toolCalls}/${state.budget.maxToolCalls}`,
  ].join(" ");

  return [
    `[summary] runId=${state.runId} status=${result.status} stopReason=${result.stopReason}`,
    `[summary] budget ${budget}`,
    usageSummaryLine(state),
    `[summary] changedFiles=${boundedList(state.changedFiles)} validations=${state.validations.length}`,
    `[summary] trace=${boundedList(trace.types, trace.total)}`,
    ...planBlockedSummaryLines(result),
  ];
}

/**
 * 详细输出只在打开时产生：`runCli` 关闭 `--verbose` 时连观察者都不创建，
 * 默认路径因此没有额外订阅、也没有额外计算。
 */
export function createVerboseObserver(write: (line: string) => void): VerboseObserver {
  const traceTypes: string[] = [];
  let eventCount = 0;

  return {
    onEvent(event) {
      eventCount += 1;
      if (traceTypes.length < MAX_VERBOSE_LIST_ITEMS) traceTypes.push(event.type);
      write(`[event] ${event.type} ${eventDetail(event)}`);
    },
    finish(result) {
      for (const line of toolObservationLines(result.state)) write(line);
      for (const line of summaryLines(result, { types: traceTypes, total: eventCount })) {
        write(line);
      }
    },
  };
}
