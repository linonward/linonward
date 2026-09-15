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
  /** 花费上限（美元）：未设置即不限制。 */
  maxCostUsd?: number | undefined;
  /** 墙钟上限（毫秒）：未设置即不限制。 */
  maxWallMs?: number | undefined;
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
  /** 审批凭证的过期时间；缺失表示这个请求不会过期（例如澄清）。 */
  expiresAt?: string | undefined;
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
  /** 这个运行此刻是否正在执行（决定"中止运行"是否可用）。 */
  cancellable?: boolean | undefined;
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
  const maxCostUsd = readOptionalNumber(value, "maxCostUsd");
  if (maxCostUsd !== undefined) budget.maxCostUsd = maxCostUsd;
  const maxWallMs = readOptionalNumber(value, "maxWallMs");
  if (maxWallMs !== undefined) budget.maxWallMs = maxWallMs;
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
  const pending: SnapshotPendingView = {
    requestId,
    question: readOptionalString(value, "question") ?? "",
    reason: readOptionalString(value, "reason") ?? "",
  };
  const expiresAt = readOptionalString(value, "expiresAt");
  if (expiresAt !== undefined) pending.expiresAt = expiresAt;
  return pending;
}

/**
 * 待答请求是否已经过期。
 *
 * 审批凭证有 15 分钟 TTL（`APPROVAL_TTL_MS`）：从"最近的运行"里重开一个放了一小时的
 * 运行，输入框还在、提交却必然被拒绝。与其让用户白填一次，不如先把这件事说出来。
 * 时间戳读不出来（或本来就没有）时按"没过期"处理——由服务端做最终裁决。
 */
export function pendingExpired(
  pending: SnapshotPendingView | undefined,
  now: number = Date.now(),
): boolean {
  if (pending?.expiresAt === undefined) return false;
  const expiresAt = Date.parse(pending.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= now;
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
  if (value["cancellable"] === true) view.cancellable = true;
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

/** 已经不会再变化的终端状态：这些运行没有"继续"可言，只有"重开一次"。 */
const TERMINAL_STATUSES = ["completed", "failed", "blocked", "cancelled"] as const;

/**
 * 快照面板要对用户说的那句话。
 *
 * 面板出现的场合差别很大：可能只是历史频道不在内存里（运行早已结束），也可能是
 * 运行正卡在等待回答、而进程已经重启。**已经结束的运行不该看到"实时流不可用、
 * 请重新启动它"**——那既不是问题，也不是用户能做的动作；而等待中的运行恰恰相反，
 * 现在真的可以接着回答（服务端会从磁盘重建它）。
 *
 * 返回 `undefined` 表示"没什么要额外说明的"。
 */
export function snapshotNotice(
  snapshot: RunSnapshotView,
  streamUnavailable: boolean,
): string | undefined {
  const hasPending = snapshot.pending !== undefined;
  const status = snapshot.status ?? "unknown";

  if (hasPending) {
    if (pendingExpired(snapshot.pending)) {
      return "这次运行等待的回答已经过期（审批凭证 15 分钟内有效），提交会被拒绝。请重新发起这个任务。";
    }
    if (!streamUnavailable) return "可以在下面提交回答，运行会接着往下走。";
    return [
      `实时流已不在（API 进程重启过），但这次运行仍停在等待回答：控制台会从磁盘上的`,
      `checkpoint 重建它再继续。批准凭证过期（15 分钟）或 lease 仍被其它进程持有时，`,
      `提交会被拒绝并给出原因。`,
    ].join("");
  }

  // 频道还在时，面板只是"顺手展示一下检查点"，不需要额外解释。
  if (!streamUnavailable) return undefined;

  if ((TERMINAL_STATUSES as readonly string[]).includes(status)) {
    return `这次运行已经结束（status=${status}）。实时频道只存在于 API 进程的内存里，所以时间线无法重放；以下是它最后一次 checkpoint 的摘要。`;
  }

  return `API 进程里已经没有这次运行的频道，而它最后一次检查点仍是 ${status}——多半是进程重启打断了它。请重新发起任务。`;
}
