/**
 * `GET /api/runs/:runId` 的浏览器侧视图。
 *
 * 实时流是首选数据源：只要频道还在，SSE 的补发就能重建完整时间线。但当 API 进程重启、
 * 或频道缓冲被挤掉时，唯一还能读到的就是磁盘上的 checkpoint——那时界面必须能靠它
 * 说清"这次运行到哪了、为什么停、要不要回答一个问题"。
 *
 * 与 `journal.ts` 的投影一样，这里坚持**缺失就是缺失**：读不到的字段不写，
 * 不用 `0` 或空串冒充；`costUsd` 缺失时由展示层显示 `unknown`。
 */

import { isPlainObject } from "./journal.js";

export interface SnapshotBudgetView {
  maxSteps?: number | undefined;
  maxToolCalls?: number | undefined;
  modelSteps?: number | undefined;
  toolCalls?: number | undefined;
}

export interface SnapshotUsageView {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cachedInputTokens?: number | undefined;
  modelCalls?: number | undefined;
  toolCalls?: number | undefined;
  wallMs?: number | undefined;
  costUsd?: number | undefined;
}

/** 等待回答的请求（审批 / 澄清）：刷新后靠它把输入框重建出来。 */
export interface SnapshotPendingView {
  requestId: string;
  question: string;
  reason: string;
}

export interface RunSnapshotView {
  runId: string;
  task?: string | undefined;
  savedAt?: string | undefined;
  status?: string | undefined;
  stopReason?: string | undefined;
  budget: SnapshotBudgetView;
  usage?: SnapshotUsageView | undefined;
  changedFiles: string[];
  plan?: unknown;
  pending?: SnapshotPendingView | undefined;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readOptionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseBudget(value: unknown): SnapshotBudgetView {
  if (!isPlainObject(value)) return {};
  const budget: SnapshotBudgetView = {};
  const maxSteps = readOptionalNumber(value, "maxSteps");
  if (maxSteps !== undefined) budget.maxSteps = maxSteps;
  const maxToolCalls = readOptionalNumber(value, "maxToolCalls");
  if (maxToolCalls !== undefined) budget.maxToolCalls = maxToolCalls;
  const modelSteps = readOptionalNumber(value, "modelSteps");
  if (modelSteps !== undefined) budget.modelSteps = modelSteps;
  const toolCalls = readOptionalNumber(value, "toolCalls");
  if (toolCalls !== undefined) budget.toolCalls = toolCalls;
  return budget;
}

/** 服务端把 `RunUsage.estimatedCostUsd` 原样透出；这里映射成展示层的 `costUsd`。 */
function parseUsage(value: unknown): SnapshotUsageView | undefined {
  if (!isPlainObject(value)) return undefined;
  const usage: SnapshotUsageView = {};
  const inputTokens = readOptionalNumber(value, "inputTokens");
  if (inputTokens !== undefined) usage.inputTokens = inputTokens;
  const outputTokens = readOptionalNumber(value, "outputTokens");
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  const cachedInputTokens = readOptionalNumber(value, "cachedInputTokens");
  if (cachedInputTokens !== undefined) usage.cachedInputTokens = cachedInputTokens;
  const modelCalls = readOptionalNumber(value, "modelCalls");
  if (modelCalls !== undefined) usage.modelCalls = modelCalls;
  const toolCalls = readOptionalNumber(value, "toolCalls");
  if (toolCalls !== undefined) usage.toolCalls = toolCalls;
  const wallMs = readOptionalNumber(value, "wallMs");
  if (wallMs !== undefined) usage.wallMs = wallMs;
  const costUsd = readOptionalNumber(value, "estimatedCostUsd");
  if (costUsd !== undefined) usage.costUsd = costUsd;
  return Object.keys(usage).length === 0 ? undefined : usage;
}

/** 只认带 `requestId` 的待答请求：没有 requestId 就渲染出无法提交的表单。 */
function parsePending(value: unknown): SnapshotPendingView | undefined {
  if (!isPlainObject(value)) return undefined;
  const requestId = readOptionalString(value, "requestId");
  if (requestId === undefined) return undefined;
  return {
    requestId,
    question: readOptionalString(value, "question") ?? "",
    reason: readOptionalString(value, "reason") ?? "",
  };
}

export function parseRunSnapshot(value: unknown): RunSnapshotView | undefined {
  if (!isPlainObject(value)) return undefined;
  const runId = readOptionalString(value, "runId");
  if (runId === undefined) return undefined;

  const view: RunSnapshotView = {
    runId,
    budget: parseBudget(value["budget"]),
    changedFiles: Array.isArray(value["changedFiles"])
      ? value["changedFiles"].filter((entry): entry is string => typeof entry === "string")
      : [],
  };

  const task = readOptionalString(value, "task");
  if (task !== undefined) view.task = task;
  const savedAt = readOptionalString(value, "savedAt");
  if (savedAt !== undefined) view.savedAt = savedAt;
  const status = readOptionalString(value, "status");
  if (status !== undefined) view.status = status;
  const stopReason = readOptionalString(value, "stopReason");
  if (stopReason !== undefined) view.stopReason = stopReason;
  const usage = parseUsage(value["usage"]);
  if (usage !== undefined) view.usage = usage;
  if (Object.hasOwn(value, "plan")) view.plan = value["plan"];
  const pending = parsePending(value["pending"]);
  if (pending !== undefined) view.pending = pending;

  return view;
}

export interface RunSummaryView {
  runId: string;
  task?: string | undefined;
  savedAt?: string | undefined;
  status?: string | undefined;
  stopReason?: string | undefined;
  /** 该运行在本进程里还有活着的频道（能接实时流）。 */
  live: boolean;
}

/** `GET /api/runs` 的列表项；字段缺失同样保持缺失。 */
export function parseRunSummary(value: unknown): RunSummaryView | undefined {
  if (!isPlainObject(value)) return undefined;
  const runId = readOptionalString(value, "runId");
  if (runId === undefined) return undefined;

  const summary: RunSummaryView = { runId, live: value["live"] === true };
  const task = readOptionalString(value, "task");
  if (task !== undefined) summary.task = task;
  const savedAt = readOptionalString(value, "savedAt");
  if (savedAt !== undefined) summary.savedAt = savedAt;
  const status = readOptionalString(value, "status");
  if (status !== undefined) summary.status = status;
  const stopReason = readOptionalString(value, "stopReason");
  if (stopReason !== undefined) summary.stopReason = stopReason;
  return summary;
}

export function parseRunSummaries(value: unknown): RunSummaryView[] {
  if (!isPlainObject(value)) return [];
  const runs = value["runs"];
  if (!Array.isArray(runs)) return [];
  return runs.flatMap((entry) => {
    const summary = parseRunSummary(entry);
    return summary === undefined ? [] : [summary];
  });
}
