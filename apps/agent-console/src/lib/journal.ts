/**
 * 从 agent-from-scratch 的 journal 记录（JSONL 的每一行）投影出界面需要的视图。
 *
 * 这里的函数是**纯函数**：给定同一串记录，永远得到同一个视图。SSE / 轮询 / 离线回放
 * 因此共用同一份逻辑，测试也不需要网络或真实模型。
 *
 * 记录形状由 `packages/agent-from-scratch-fixture/src/cli-journal.ts` 定义；这里刻意
 * 按字段**逐项做类型收窄**（`typeof` 检查）而不是断言，缺字段就当作未知，绝不用 0 冒充。
 */

/** 解析出来的一条 journal 记录。字段逐个收窄，因此用 `Record<string, unknown>`。 */
export type JournalRecord = Record<string, unknown>;

/** 非数组对象收窄。与 fixture 的 `isRecord` 同一口径。 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJournalRecord(value: unknown): value is JournalRecord {
  return isPlainObject(value) && typeof value["kind"] === "string";
}

/** `Array.isArray` 的窄化版本：返回 `unknown[]` 而不是 `any[]`。 */
export function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** SSE / JSONL 的一行 → 记录；不是合法 JSON 或没有 `kind` 时返回 `undefined`。 */
export function parseJournalRecord(raw: string): JournalRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  return isJournalRecord(parsed) ? parsed : undefined;
}

export function readString(record: JournalRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

export function readNumber(record: JournalRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function readBoolean(record: JournalRecord, key: string): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

export function readRecord(record: JournalRecord, key: string): JournalRecord | undefined {
  const value = record[key];
  return isPlainObject(value) ? value : undefined;
}

export function readArray(record: JournalRecord, key: string): unknown[] | undefined {
  const value = record[key];
  return isUnknownArray(value) ? value : undefined;
}

export function readStringArray(record: JournalRecord, key: string): string[] | undefined {
  const value = readArray(record, key);
  if (value === undefined) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

export function readRecordArray(record: JournalRecord, key: string): JournalRecord[] {
  const value = readArray(record, key);
  if (value === undefined) return [];
  return value.filter(isPlainObject);
}

export interface ModelRequestMessageView {
  role: string;
  content: string;
}

export interface ModelRequestOutputView {
  callId: string;
  output: string;
}

export interface ModelRequestView {
  instructions: string;
  input: ModelRequestMessageView[];
  outputs: ModelRequestOutputView[];
  toolNames: string[];
  previousResponseId?: string | undefined;
}

export interface ModelUsageView {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cachedInputTokens?: number | undefined;
  durationMs?: number | undefined;
  modelId?: string | undefined;
  costUsd?: number | undefined;
}

export interface ToolResultView {
  ok?: boolean | undefined;
  errorCode?: string | undefined;
  reason?: string | undefined;
  effect?: string | undefined;
  durationMs?: number | undefined;
  output?: string | undefined;
  waiting?: { requestId: string; reason: string } | undefined;
  policy?: JournalRecord | undefined;
}

export interface ToolCallView {
  callId: string;
  name: string;
  argumentsJson: string;
  durationMs?: number | undefined;
  result?: ToolResultView | undefined;
}

export interface ModelRoundView {
  step: number;
  phase: "start" | "continue" | "unknown";
  request?: ModelRequestView | undefined;
  responseId?: string | undefined;
  durationMs?: number | undefined;
  /** 模型这一轮的可见推理；缺失即模型没有返回 reasoning。 */
  reasoning?: string[] | undefined;
  finalText?: string | undefined;
  toolCalls: ToolCallView[];
  usage?: ModelUsageView | undefined;
}

export interface PlanChangeView {
  version?: number | undefined;
  reason: string;
  detail?: JournalRecord | undefined;
  at?: string | undefined;
}

export interface RunStartView {
  at?: string | undefined;
  task?: string | undefined;
  cwd?: string | undefined;
  modelId?: string | undefined;
  budgets?: { maxSteps?: number | undefined; maxToolCalls?: number | undefined } | undefined;
  allowedArgv: string[][];
  requireSandbox?: boolean | undefined;
}

export interface UsageTotalsView {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cachedInputTokens?: number | undefined;
  modelCalls: number;
  toolCalls: number;
  wallMs?: number | undefined;
  costUsd?: number | undefined;
  /** 只有真的算得出成本时才是 `true`；否则界面必须显示 `cost=unknown`。 */
  costKnown: boolean;
  prices?: { asOf?: string | undefined; source?: string | undefined } | undefined;
  costBasis?: string | undefined;
  /** `run` = 来自运行结束的汇总记录；`sum` = 由单次调用记录累加得出。 */
  source: "run" | "sum";
}

export interface BudgetView {
  modelSteps: number;
  maxSteps?: number | undefined;
  toolCalls: number;
  maxToolCalls?: number | undefined;
}

export interface StopView {
  status?: string | undefined;
  stopReason?: string | undefined;
  /** `budget_exhausted` / `plan_blocked` 的原始事件 detail。 */
  detail?: JournalRecord | undefined;
  detailKind?: string | undefined;
  /** 由 detail 推导出的可读提示（不是猜的：字段全部来自 detail）。 */
  hint?: string | undefined;
}

export interface RunView {
  runId: string;
  start?: RunStartView | undefined;
  rounds: ModelRoundView[];
  planChanges: PlanChangeView[];
  /** 折叠的原始日志区：可读日志行 + `[event]` 行。 */
  logLines: string[];
  usage: UsageTotalsView;
  budget: BudgetView;
  stop?: StopView | undefined;
  errors: string[];
  done: boolean;
}

function readPhase(record: JournalRecord): ModelRoundView["phase"] {
  const phase = readString(record, "phase");
  return phase === "start" || phase === "continue" ? phase : "unknown";
}

function readRequest(record: JournalRecord): ModelRequestView {
  const request: ModelRequestView = {
    instructions: readString(record, "instructions") ?? "",
    input: readRecordArray(record, "input").map((message) => ({
      role: readString(message, "role") ?? "unknown",
      content: readString(message, "content") ?? "",
    })),
    outputs: readRecordArray(record, "outputs").map((output) => ({
      callId: readString(output, "callId") ?? "",
      output: readString(output, "output") ?? "",
    })),
    toolNames: readStringArray(record, "toolNames") ?? [],
  };
  const previousResponseId = readString(record, "previousResponseId");
  if (previousResponseId !== undefined) request.previousResponseId = previousResponseId;
  return request;
}

function readToolCall(record: JournalRecord): ToolCallView {
  return {
    callId: readString(record, "callId") ?? "",
    name: readString(record, "name") ?? "(unknown)",
    argumentsJson: readString(record, "argumentsJson") ?? "",
  };
}

function readToolResult(record: JournalRecord): ToolResultView {
  const result: ToolResultView = {};
  const ok = readBoolean(record, "ok");
  if (ok !== undefined) result.ok = ok;
  const errorCode = readString(record, "error");
  if (errorCode !== undefined) result.errorCode = errorCode;
  const reason = readString(record, "reason");
  if (reason !== undefined) result.reason = reason;
  const effect = readString(record, "effect");
  if (effect !== undefined) result.effect = effect;
  const durationMs = readNumber(record, "durationMs");
  if (durationMs !== undefined) result.durationMs = durationMs;
  const output = readString(record, "output");
  if (output !== undefined) result.output = output;
  const policy = readRecord(record, "policy");
  if (policy !== undefined) result.policy = policy;
  const waiting = readRecord(record, "waiting");
  if (waiting !== undefined) {
    result.waiting = {
      requestId: readString(waiting, "requestId") ?? "",
      reason: readString(waiting, "reason") ?? "",
    };
  }
  return result;
}

function readStart(record: JournalRecord): RunStartView {
  const start: RunStartView = {
    allowedArgv: (readArray(record, "allowedArgv") ?? []).map((argv) =>
      isUnknownArray(argv) ? argv.filter((item): item is string => typeof item === "string") : [],
    ),
  };
  const at = readString(record, "at");
  if (at !== undefined) start.at = at;
  const task = readString(record, "task");
  if (task !== undefined) start.task = task;
  const cwd = readString(record, "cwd");
  if (cwd !== undefined) start.cwd = cwd;
  const modelId = readString(record, "modelId");
  if (modelId !== undefined) start.modelId = modelId;
  const requireSandbox = readBoolean(record, "requireSandbox");
  if (requireSandbox !== undefined) start.requireSandbox = requireSandbox;
  const budgets = readRecord(record, "budgets");
  if (budgets !== undefined) {
    start.budgets = {
      maxSteps: readNumber(budgets, "maxSteps"),
      maxToolCalls: readNumber(budgets, "maxToolCalls"),
    };
  }
  return start;
}

function readModelUsage(record: JournalRecord): ModelUsageView {
  const usage: ModelUsageView = {};
  const inputTokens = readNumber(record, "inputTokens");
  if (inputTokens !== undefined) usage.inputTokens = inputTokens;
  const outputTokens = readNumber(record, "outputTokens");
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  const cachedInputTokens = readNumber(record, "cachedInputTokens");
  if (cachedInputTokens !== undefined) usage.cachedInputTokens = cachedInputTokens;
  const durationMs = readNumber(record, "durationMs");
  if (durationMs !== undefined) usage.durationMs = durationMs;
  const modelId = readString(record, "model");
  if (modelId !== undefined) usage.modelId = modelId;
  const costUsd = readNumber(record, "costUsd");
  if (costUsd !== undefined) usage.costUsd = costUsd;
  return usage;
}

function readBudgetFromDetail(detail: JournalRecord): BudgetView | undefined {
  const budget = readRecord(detail, "budget");
  if (budget === undefined) return undefined;
  const modelSteps = readNumber(budget, "modelSteps");
  const toolCalls = readNumber(budget, "toolCalls");
  if (modelSteps === undefined || toolCalls === undefined) return undefined;
  const view: BudgetView = { modelSteps, toolCalls };
  const maxSteps = readNumber(budget, "maxSteps");
  if (maxSteps !== undefined) view.maxSteps = maxSteps;
  const maxToolCalls = readNumber(budget, "maxToolCalls");
  if (maxToolCalls !== undefined) view.maxToolCalls = maxToolCalls;
  return view;
}

/** 由事件 detail 推导可读提示；缺字段的组合返回 `undefined`，不猜。 */
export function deriveStopHint(detail: JournalRecord): string | undefined {
  const kind = readString(detail, "type");
  if (kind === "plan_blocked") {
    const summary = readString(detail, "summary");
    const reason = readString(detail, "reason");
    if (summary === undefined) return reason === undefined ? undefined : `plan_blocked: ${reason}`;
    return reason === undefined ? summary : `${summary}（reason=${reason}）`;
  }
  if (kind !== "budget_exhausted") return undefined;

  const parts: string[] = [];
  const reason = readString(detail, "reason");
  if (reason !== undefined) parts.push(`reason=${reason}`);
  const budget = readBudgetFromDetail(detail);
  if (budget !== undefined) {
    parts.push(`modelSteps=${budget.modelSteps}/${budget.maxSteps ?? "?"}`);
    parts.push(`toolCalls=${budget.toolCalls}/${budget.maxToolCalls ?? "?"}`);
  }
  const usage = readRecord(detail, "usage");
  if (usage !== undefined) {
    const cost = readString(usage, "cost");
    if (cost !== undefined) parts.push(`cost=${cost}`);
  }
  const pending = readArray(detail, "pendingSteps")?.length;
  const omitted = readNumber(detail, "pendingStepsOmitted") ?? 0;
  if (pending !== undefined) parts.push(`pending=${pending + omitted}`);
  const active = readString(detail, "activeStepId");
  if (active !== undefined) parts.push(`active=${active}`);
  const lastReplan = readString(detail, "lastReplanReason");
  if (lastReplan !== undefined) parts.push(`lastReplan=${lastReplan}`);
  return parts.length === 0 ? undefined : parts.join("；");
}

interface MutableTotals {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  cachedInputTokens: number | undefined;
  modelCalls: number;
  toolCalls: number;
  durationSumMs: number;
  costSumUsd: number | undefined;
  costComplete: boolean;
  hasModelUsage: boolean;
}

function emptyTotals(): MutableTotals {
  return {
    inputTokens: undefined,
    outputTokens: undefined,
    cachedInputTokens: undefined,
    modelCalls: 0,
    toolCalls: 0,
    durationSumMs: 0,
    costSumUsd: undefined,
    costComplete: true,
    hasModelUsage: false,
  };
}

function addTokens(current: number | undefined, next: number | undefined): number | undefined {
  if (next === undefined) return current;
  return (current ?? 0) + next;
}

function wallMsBetween(
  firstAt: string | undefined,
  lastAt: string | undefined,
): number | undefined {
  if (firstAt === undefined || lastAt === undefined) return undefined;
  const start = Date.parse(firstAt);
  const end = Date.parse(lastAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return undefined;
  return end - start;
}

/**
 * 记录序列 → 运行视图：按轮次分组模型请求/响应/工具结果，并累加用量与成本。
 *
 * 成本口径：优先用运行结束的 `usage(scope=run)` 记录；只有它才能给出"官方"估算。
 * 回退到逐次累加时，只要有一次模型调用没给出 `costUsd`，整体就保持 `costKnown=false`
 * ——部分求和会被误读成"这就是全部成本"。
 */
export function projectRun(runId: string, records: readonly JournalRecord[]): RunView {
  const roundIndex = new Map<number, ModelRoundView>();
  const roundOrder: number[] = [];
  const stepByCallId = new Map<string, number>();
  const planChanges: PlanChangeView[] = [];
  const logLines: string[] = [];
  const errors: string[] = [];
  const totals = emptyTotals();
  let start: RunStartView | undefined;
  let stop: StopView | undefined;
  let budgetFromDetail: BudgetView | undefined;
  let runUsage: UsageTotalsView | undefined;
  let firstAt: string | undefined;
  let lastAt: string | undefined;
  let lastStep: number | undefined;
  let done = false;

  const roundFor = (step: number, phase: ModelRoundView["phase"]): ModelRoundView => {
    const existing = roundIndex.get(step);
    if (existing !== undefined) return existing;
    const created: ModelRoundView = { step, phase, toolCalls: [] };
    roundIndex.set(step, created);
    roundOrder.push(step);
    if (lastStep === undefined || step > lastStep) lastStep = step;
    return created;
  };

  const roundForCall = (callId: string): ModelRoundView | undefined => {
    const step = stepByCallId.get(callId) ?? lastStep;
    if (step === undefined) return undefined;
    return roundFor(step, "unknown");
  };

  for (const record of records) {
    const at = readString(record, "at");
    if (at !== undefined) {
      if (firstAt === undefined) firstAt = at;
      lastAt = at;
    }

    switch (readString(record, "kind")) {
      case "run_started": {
        start = readStart(record);
        break;
      }
      case "log_line": {
        const text = readString(record, "text");
        if (text !== undefined) logLines.push(text);
        break;
      }
      case "model_request": {
        const step = readNumber(record, "step");
        if (step === undefined) break;
        const round = roundFor(step, readPhase(record));
        round.phase = readPhase(record);
        round.request = readRequest(record);
        break;
      }
      case "model_response": {
        const step = readNumber(record, "step");
        if (step === undefined) break;
        const round = roundFor(step, readPhase(record));
        round.phase = readPhase(record);
        const responseId = readString(record, "responseId");
        if (responseId !== undefined) round.responseId = responseId;
        const durationMs = readNumber(record, "durationMs");
        if (durationMs !== undefined) round.durationMs = durationMs;
        const reasoning = readStringArray(record, "reasoning");
        if (reasoning !== undefined && reasoning.length > 0) round.reasoning = reasoning;
        const finalText = readString(record, "finalText");
        if (finalText !== undefined) round.finalText = finalText;
        for (const call of readRecordArray(record, "toolCalls")) {
          const view = readToolCall(call);
          stepByCallId.set(view.callId, step);
          if (!round.toolCalls.some((existing) => existing.callId === view.callId)) {
            round.toolCalls.push(view);
          }
        }
        break;
      }
      case "tool_call": {
        totals.toolCalls += 1;
        const view = readToolCall(record);
        const round = roundForCall(view.callId);
        if (round === undefined) break;
        const durationMs = readNumber(record, "durationMs");
        if (durationMs !== undefined) view.durationMs = durationMs;
        const existing = round.toolCalls.find((call) => call.callId === view.callId);
        if (existing === undefined) round.toolCalls.push(view);
        else if (view.durationMs !== undefined) existing.durationMs = view.durationMs;
        break;
      }
      case "tool_result": {
        const callId = readString(record, "callId") ?? "";
        const result = readToolResult(record);
        const round = roundForCall(callId);
        if (round === undefined) break;
        const existing = round.toolCalls.find((call) => call.callId === callId);
        if (existing === undefined) {
          round.toolCalls.push({
            callId,
            name: readString(record, "name") ?? "(unknown)",
            argumentsJson: "",
            result,
          });
        } else {
          existing.result = result;
        }
        break;
      }
      case "usage": {
        const scope = readString(record, "scope");
        if (scope === "model") {
          const usage = readModelUsage(record);
          totals.hasModelUsage = true;
          totals.modelCalls += 1;
          totals.inputTokens = addTokens(totals.inputTokens, usage.inputTokens);
          totals.outputTokens = addTokens(totals.outputTokens, usage.outputTokens);
          totals.cachedInputTokens = addTokens(totals.cachedInputTokens, usage.cachedInputTokens);
          totals.durationSumMs += usage.durationMs ?? 0;
          if (usage.costUsd === undefined) totals.costComplete = false;
          else totals.costSumUsd = (totals.costSumUsd ?? 0) + usage.costUsd;
          const step = readNumber(record, "step");
          if (step !== undefined) roundFor(step, readPhase(record)).usage = usage;
          break;
        }
        if (scope === "run") {
          const view: UsageTotalsView = {
            modelCalls: readNumber(record, "modelCalls") ?? totals.modelCalls,
            toolCalls: readNumber(record, "toolCalls") ?? totals.toolCalls,
            costKnown: readNumber(record, "costUsd") !== undefined,
            source: "run",
          };
          const inputTokens = readNumber(record, "inputTokens");
          if (inputTokens !== undefined) view.inputTokens = inputTokens;
          const outputTokens = readNumber(record, "outputTokens");
          if (outputTokens !== undefined) view.outputTokens = outputTokens;
          const cachedInputTokens = readNumber(record, "cachedInputTokens");
          if (cachedInputTokens !== undefined) view.cachedInputTokens = cachedInputTokens;
          const wallMs = readNumber(record, "wallMs");
          if (wallMs !== undefined) view.wallMs = wallMs;
          const costUsd = readNumber(record, "costUsd");
          if (costUsd !== undefined) view.costUsd = costUsd;
          const prices = readRecord(record, "prices");
          if (prices !== undefined) {
            view.prices = {
              asOf: readString(prices, "asOf"),
              source: readString(prices, "source"),
            };
          }
          const costBasis = readString(record, "costBasis");
          if (costBasis !== undefined) view.costBasis = costBasis;
          runUsage = view;
          break;
        }
        break;
      }
      case "plan_revised": {
        const change: PlanChangeView = {
          reason: readString(record, "reason") ?? "(未给出原因)",
        };
        const version = readNumber(record, "version");
        if (version !== undefined) change.version = version;
        const detail = readRecord(record, "detail");
        if (detail !== undefined) change.detail = detail;
        if (at !== undefined) change.at = at;
        planChanges.push(change);
        break;
      }
      case "budget_exhausted":
      case "plan_blocked": {
        const detail: JournalRecord = { ...record, type: readString(record, "kind") };
        const nextStop: StopView = { detail, detailKind: readString(record, "kind") };
        if (stop?.status !== undefined) nextStop.status = stop.status;
        if (stop?.stopReason !== undefined) nextStop.stopReason = stop.stopReason;
        const hint = deriveStopHint(detail);
        if (hint !== undefined) nextStop.hint = hint;
        stop = nextStop;
        const detailBudget = readBudgetFromDetail(detail);
        if (detailBudget !== undefined) budgetFromDetail = detailBudget;
        break;
      }
      case "run_stopped": {
        const nextStop: StopView = stop ?? {};
        const status = readString(record, "status");
        if (status !== undefined) nextStop.status = status;
        const stopReason = readString(record, "stopReason");
        if (stopReason !== undefined) nextStop.stopReason = stopReason;
        const hint = readString(record, "hint");
        const detail = readRecord(record, "detail");
        if (detail !== undefined) {
          nextStop.detail = detail;
          nextStop.detailKind = readString(detail, "type") ?? nextStop.detailKind;
        }
        if (hint !== undefined) nextStop.hint = hint;
        else if (nextStop.detail !== undefined && nextStop.hint === undefined) {
          const derived = deriveStopHint(nextStop.detail);
          if (derived !== undefined) nextStop.hint = derived;
        }
        stop = nextStop;
        done = true;
        break;
      }
      case "run_error": {
        const message = readString(record, "message");
        errors.push(message ?? "运行失败（未提供错误信息）");
        done = true;
        break;
      }
      default:
        break;
    }
  }

  const usage: UsageTotalsView =
    runUsage ??
    ({
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cachedInputTokens: totals.cachedInputTokens,
      modelCalls: totals.modelCalls,
      toolCalls: totals.toolCalls,
      wallMs:
        wallMsBetween(firstAt, lastAt) ??
        (totals.durationSumMs > 0 ? totals.durationSumMs : undefined),
      costUsd: totals.costComplete ? totals.costSumUsd : undefined,
      costKnown: totals.costComplete && totals.costSumUsd !== undefined && totals.hasModelUsage,
      source: "sum",
    } satisfies UsageTotalsView);

  const maxSteps = start?.budgets?.maxSteps;
  const maxToolCalls = start?.budgets?.maxToolCalls;
  const derivedBudget: BudgetView = {
    modelSteps: usage.modelCalls,
    toolCalls: usage.toolCalls,
  };
  if (maxSteps !== undefined) derivedBudget.maxSteps = maxSteps;
  if (maxToolCalls !== undefined) derivedBudget.maxToolCalls = maxToolCalls;

  const view: RunView = {
    runId,
    rounds: roundOrder.map((step) => {
      const round = roundIndex.get(step);
      if (round === undefined) throw new Error("unreachable: round index lost a registered step");
      return round;
    }),
    planChanges,
    logLines,
    usage,
    budget: budgetFromDetail ?? derivedBudget,
    errors,
    done,
  };
  if (start !== undefined) view.start = start;
  if (stop !== undefined) view.stop = stop;
  return view;
}

/** 视图中是否还有等待回答的请求（审批 / 澄清）。 */
export function pendingQuestion(view: RunView): { requestId: string; reason: string } | undefined {
  for (const round of view.rounds) {
    for (const call of round.toolCalls) {
      if (call.result?.waiting !== undefined) return call.result.waiting;
    }
  }
  return undefined;
}
