import { closeSync, openSync, writeSync } from "node:fs";

import type { BudgetExhaustedDetail, PlanRevisedDetail } from "./agent-loop.js";
import { isRecord } from "./checkpoint.js";
import type { ToolExecutionResult } from "./execute-tool.js";
import type { ModelDriver, ModelTurn, ModelUsage, ToolCall } from "./model.js";
import type { PolicyDecision } from "./policy.js";
import { estimateCostUsd, formatCostUsd, type PriceTable } from "./pricing.js";
import { formatUsageNumber, type RunUsage } from "./trace.js";

/**
 * 单条内容的默认上限：超出后写 `…truncated(原长度 N)`。
 *
 * 模型 payload 与工具结果都可能非常长，完整日志必须**保底不炸终端**；
 * `--no-truncate` 才会写全文（此时还会在 stderr 顶部给出显式警告）。
 */
export const DEFAULT_JOURNAL_MAX_CHARACTERS = 20_000;

/** `run_started`：任务、工作区、预算、白名单与模型 id（**绝不包含密钥**）。 */
export interface JournalRunMeta {
  command: string;
  task?: string | undefined;
  cwd: string;
  /** 预算与硬上限：`run_started` 记录是进程重启后重建一次运行的唯一来源。 */
  budgets: {
    maxSteps: number;
    maxToolCalls: number;
    maxCostUsd?: number | undefined;
    maxWallMs?: number | undefined;
  };
  allowedArgv: string[][];
  requireSandbox: boolean;
  /**
   * 这次运行是否对策略放行的命令自动批准。写进 journal 是为了让长驻进程在重启后
   * 仍能按同一套策略续跑一次等待中的运行——缺失一律按 `false`（宁可多问一次）。
   */
  approveAllowed?: boolean | undefined;
  modelId?: string | undefined;
}

/** 模型输入里的一条消息（continue 的 outputs 单独用 `outputs` 表达）。 */
export interface JournalMessage {
  role: string;
  content: string;
}

/** 模型请求：system prompt 全文 + 每条输入消息全文 + 工具名称列表 + 第几轮。 */
export interface JournalModelRequest {
  step: number;
  phase: "start" | "continue";
  instructions: string;
  input: readonly JournalMessage[];
  outputs?: readonly { callId: string; output: string }[] | undefined;
  toolNames: readonly string[];
  previousResponseId?: string | undefined;
}

/** 模型响应：responseId、finalText 全文、toolCalls（含参数 JSON 全文）与耗时。 */
export interface JournalModelResponse {
  step: number;
  phase: "start" | "continue";
  responseId: string;
  finalText: string;
  /**
   * 可见推理（思维链）。缺失即模型没返回 reasoning——不写空数组冒充。
   * **只用于观测**：它不会进入任何 prompt / 上下文。
   */
  reasoning?: readonly string[] | undefined;
  toolCalls: readonly { callId: string; name: string; argumentsJson: string }[];
  durationMs: number;
}

/** 工具调用：callId、工具名、argsJson 全文与耗时。 */
export interface JournalToolCall {
  callId: string;
  name: string;
  argumentsJson: string;
  durationMs: number;
}

/** 工具结果：observation 全文、ok / effect / errorCode，以及（若可得）policy 决定。 */
export interface JournalToolResult {
  callId: string;
  name: string;
  durationMs: number;
  ok?: boolean | undefined;
  effect?: string | undefined;
  /** 失败错误码。可读行写 `error=<code>`，JSONL 的字段名也是 `error`。 */
  errorCode?: string | undefined;
  output?: string | undefined;
  waiting?: { requestId: string; reason: string } | undefined;
  policy?: PolicyDecision | undefined;
}

/**
 * 单次模型调用的用量。**字段缺失即未知**：输出 `unknown`，绝不写 0 冒充。
 */
export interface JournalModelUsage {
  scope: "model";
  step: number;
  phase: "start" | "continue";
  modelId?: string | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cachedInputTokens?: number | undefined;
  durationMs: number;
  costUsd?: number | undefined;
}

/** 运行结束的累计用量（含价目表的 `asOf` / `source` 与计价口径）。 */
export interface JournalRunUsage {
  scope: "run";
  modelCalls: number;
  toolCalls: number;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cachedInputTokens?: number | undefined;
  /** 整轮墙钟时间（毫秒）。 */
  wallMs: number;
  costUsd?: number | undefined;
  /** 价目表的版本与来源；没有价目表时省略。 */
  prices?: { asOf: string; source?: string | undefined } | undefined;
  /** 计价口径注解（缓存如何计价）；模型不在表里时省略。 */
  costBasis?: string | undefined;
}

export type JournalUsage = JournalModelUsage | JournalRunUsage;

/** `plan_revised` 的 JSONL 记录：为什么改、改了什么、触发证据。 */
export interface JournalPlanRevised {
  version: number;
  reason: string;
  detail?: PlanRevisedDetail | undefined;
}

/** 可读行：`[usage] step=2 phase=continue in=1234 out=256 cached=1024 durationMs=3210 model=... cost=$...` */
export function formatModelUsageLine(entry: JournalModelUsage): string {
  return [
    "[usage]",
    `step=${entry.step}`,
    `phase=${entry.phase}`,
    `in=${formatUsageNumber(entry.inputTokens)}`,
    `out=${formatUsageNumber(entry.outputTokens)}`,
    `cached=${formatUsageNumber(entry.cachedInputTokens)}`,
    `durationMs=${entry.durationMs}`,
    `model=${entry.modelId ?? "unknown"}`,
    `cost=${formatCostUsd(entry.costUsd)}`,
  ].join(" ");
}

/**
 * 可读行：`[usage] run: modelCalls=4 toolCalls=7 in=... out=... cached=... wallMs=... cost=$... (prices asOf=..., source=...)`。
 *
 * `cost=unknown` 时仍然给出价目表的 `asOf` / `source`：读者要能区分"算不出"
 * 与"价格表是空的"。
 */
export function formatRunUsageLine(entry: JournalRunUsage): string {
  const fields = [
    "[usage] run:",
    `modelCalls=${entry.modelCalls}`,
    `toolCalls=${entry.toolCalls}`,
    `in=${formatUsageNumber(entry.inputTokens)}`,
    `out=${formatUsageNumber(entry.outputTokens)}`,
    `cached=${formatUsageNumber(entry.cachedInputTokens)}`,
    `wallMs=${entry.wallMs}`,
    `cost=${formatCostUsd(entry.costUsd)}`,
  ].join(" ");

  if (entry.prices === undefined) return fields;
  const source = entry.prices.source === undefined ? "" : `, source=${entry.prices.source}`;
  const basis = entry.costBasis === undefined ? "" : `; ${entry.costBasis}`;
  return `${fields} (prices asOf=${entry.prices.asOf}${source}${basis})`;
}

/**
 * `budget_exhausted` 的可读摘要行：一行回答"为什么停、卡在哪、还差多少"。
 * 字段全部来自有界的事件 detail。
 */
export function formatBudgetExhaustedLine(entry: BudgetExhaustedDetail): string {
  const pending = entry.pendingSteps.length + entry.pendingStepsOmitted;
  return [
    "[budget] exhausted",
    `reason=${entry.reason}`,
    `modelSteps=${entry.budget.modelSteps}/${entry.budget.maxSteps}`,
    `toolCalls=${entry.budget.toolCalls}/${entry.budget.maxToolCalls}`,
    `cost=${entry.usage.cost}`,
    `active=${entry.activeStepId ?? "none"}`,
    `pending=${pending}`,
  ].join(" ");
}

/**
 * 完整运行日志。统一做「stderr 可读行 + 可选 JSONL 文件」双写，并统一应用时间戳与截断。
 *
 * 只有 `--verbose` 打开时才是活动对象；关闭时 `createJournal` 返回 no-op，
 * 既不创建文件、也不产生任何 stderr 输出（默认路径逐字节不变、零额外开销）。
 */
export interface Journal {
  readonly active: boolean;
  runMeta(entry: JournalRunMeta): void;
  modelRequest(entry: JournalModelRequest): void;
  modelResponse(entry: JournalModelResponse): void;
  toolCall(entry: JournalToolCall): void;
  toolResult(entry: JournalToolResult): void;
  /** 用量：单次模型调用一行 / 运行结束一行汇总，两边同时写 stderr 与 JSONL（`kind: "usage"`）。 */
  usage(entry: JournalUsage): void;
  /**
   * `plan_revised` 的详情。**只写 JSONL**（`kind: "plan_revised"`）：可读行由
   * verbose observer 的 `[event] plan_revised ...` 负责，这里不重复打印同一件事。
   */
  planRevised(entry: JournalPlanRevised): void;
  /**
   * 预算耗尽（`max_steps` / `max_tool_calls`）的诊断：stderr 一行可读摘要 +
   * JSONL（`kind: "budget_exhausted"`，字段与 Loop 写出的事件 detail 一致）。
   */
  budgetExhausted(entry: BudgetExhaustedDetail): void;
  close(): void;
}

export interface JournalOptions {
  verbose: boolean;
  logPath?: string | undefined;
  truncate: boolean;
  write: (line: string) => void;
  /** 可注入时钟，便于测试固定时间戳；默认系统时间。 */
  now?: (() => Date) | undefined;
}

/**
 * 从 observation JSON（`{"ok":false,"error":"<code>","message":"<可读原因>"}`）里取可读原因。
 * 解析不出来或没有 `message` 时返回 `undefined`：不猜、也不把 JSON 原文当原因。
 */
function observationReason(output: string | undefined): string | undefined {
  if (output === undefined) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;

  const message = parsed["message"];
  return typeof message === "string" && message.trim().length > 0 ? message : undefined;
}

function createNoopJournal(): Journal {
  return {
    active: false,
    runMeta: () => undefined,
    modelRequest: () => undefined,
    modelResponse: () => undefined,
    toolCall: () => undefined,
    toolResult: () => undefined,
    usage: () => undefined,
    planRevised: () => undefined,
    budgetExhausted: () => undefined,
    close: () => undefined,
  };
}

/**
 * 打开完整日志。
 *
 * 活动条件是 `verbose === true`：`--log` 只是把**同一条**日志额外落成 JSONL，
 * 因此 `--verbose` 关闭时不会创建 journal，也不会创建日志文件。
 */
export function createJournal(options: JournalOptions): Journal {
  if (options.verbose !== true) return createNoopJournal();

  const now = options.now ?? ((): Date => new Date());
  const fd = options.logPath === undefined ? undefined : openSync(options.logPath, "a");
  let closed = false;

  const clip = (text: string): string => {
    if (!options.truncate || text.length <= DEFAULT_JOURNAL_MAX_CHARACTERS) return text;
    return `${text.slice(0, DEFAULT_JOURNAL_MAX_CHARACTERS)}…truncated(原长度 ${text.length})`;
  };

  const writeRecord = (record: Record<string, unknown>): void => {
    if (fd === undefined) return;
    writeSync(fd, `${JSON.stringify(record)}\n`);
  };

  const writeLine = (line: string): void => {
    options.write(line);
  };

  if (!options.truncate) {
    const at = now().toISOString();
    writeRecord({ kind: "journal_warning", at, truncation: "disabled" });
    writeLine(
      "[journal] warning: truncation disabled (--no-truncate); full model payloads and tool results will be written",
    );
  }

  return {
    active: true,

    runMeta(entry) {
      const at = now().toISOString();
      const record: Record<string, unknown> = {
        kind: "run_started",
        at,
        durationMs: 0,
        command: entry.command,
        cwd: entry.cwd,
        budgets: entry.budgets,
        allowedArgv: entry.allowedArgv,
        requireSandbox: entry.requireSandbox,
      };
      if (entry.task !== undefined) record["task"] = clip(entry.task);
      if (entry.approveAllowed !== undefined) record["approveAllowed"] = entry.approveAllowed;
      if (entry.modelId !== undefined) record["modelId"] = entry.modelId;

      writeRecord(record);
      writeLine(
        [
          `[run] started at=${at} command=${entry.command}`,
          `cwd=${entry.cwd}`,
          `model=${entry.modelId ?? "(injected)"}`,
          `maxSteps=${entry.budgets.maxSteps}`,
          `maxToolCalls=${entry.budgets.maxToolCalls}`,
          `requireSandbox=${String(entry.requireSandbox)}`,
          `approveAllowed=${String(entry.approveAllowed ?? false)}`,
        ].join(" "),
      );
      if (entry.task !== undefined) writeLine(`[run] task: ${clip(entry.task)}`);
      writeLine(`[run] allowedArgv: ${JSON.stringify(entry.allowedArgv)}`);
    },

    modelRequest(entry) {
      const at = now().toISOString();
      const outputs = entry.outputs ?? [];
      const record: Record<string, unknown> = {
        kind: "model_request",
        at,
        durationMs: 0,
        step: entry.step,
        phase: entry.phase,
        instructions: clip(entry.instructions),
        input: entry.input.map((message) => ({
          role: message.role,
          content: clip(message.content),
        })),
        outputs: outputs.map((output) => ({ callId: output.callId, output: clip(output.output) })),
        toolNames: [...entry.toolNames],
      };
      if (entry.previousResponseId !== undefined) {
        record["previousResponseId"] = entry.previousResponseId;
      }

      writeRecord(record);
      writeLine(`[model] request step=${entry.step} phase=${entry.phase} at=${at} durationMs=0`);
      writeLine(`[model] instructions: ${clip(entry.instructions)}`);
      entry.input.forEach((message, index) => {
        writeLine(`[model] input[${index}] role=${message.role}: ${clip(message.content)}`);
      });
      outputs.forEach((output, index) => {
        writeLine(`[model] output[${index}] callId=${output.callId}: ${clip(output.output)}`);
      });
      if (entry.previousResponseId !== undefined) {
        writeLine(`[model] previousResponseId=${entry.previousResponseId}`);
      }
      const tools = entry.toolNames.length === 0 ? "(none)" : entry.toolNames.join(",");
      writeLine(`[model] tools: ${tools}`);
    },

    modelResponse(entry) {
      const at = now().toISOString();
      const record: Record<string, unknown> = {
        kind: "model_response",
        at,
        durationMs: entry.durationMs,
        step: entry.step,
        phase: entry.phase,
        responseId: entry.responseId,
        finalText: clip(entry.finalText),
        toolCalls: entry.toolCalls.map((call) => ({
          callId: call.callId,
          name: call.name,
          argumentsJson: clip(call.argumentsJson),
        })),
      };
      // 思维链与 finalText 分开存放，并逐块遵守同一条截断规则。
      if (entry.reasoning !== undefined) {
        record["reasoning"] = entry.reasoning.map((block) => clip(block));
      }

      writeRecord(record);
      writeLine(
        [
          `[model] response step=${entry.step} phase=${entry.phase}`,
          `at=${at}`,
          `durationMs=${entry.durationMs}`,
          `responseId=${entry.responseId}`,
          `toolCalls=${entry.toolCalls.length}`,
        ].join(" "),
      );
      writeLine(`[model] finalText: ${clip(entry.finalText)}`);
      if (entry.reasoning !== undefined) {
        entry.reasoning.forEach((block, index) => {
          writeLine(`[model] reasoning[${index}]: ${clip(block)}`);
        });
      }
      for (const call of entry.toolCalls) {
        writeLine(
          `[model] toolCall callId=${call.callId} name=${call.name} argumentsJson=${clip(call.argumentsJson)}`,
        );
      }
    },

    toolCall(entry) {
      const at = now().toISOString();
      writeRecord({
        kind: "tool_call",
        at,
        durationMs: entry.durationMs,
        callId: entry.callId,
        name: entry.name,
        argumentsJson: clip(entry.argumentsJson),
      });
      writeLine(
        [
          `[tool] call callId=${entry.callId}`,
          `name=${entry.name}`,
          `at=${at}`,
          `durationMs=${entry.durationMs}`,
          `argsJson=${clip(entry.argumentsJson)}`,
        ].join(" "),
      );
    },

    toolResult(entry) {
      const at = now().toISOString();
      const reason = entry.ok === false ? observationReason(entry.output) : undefined;
      const record: Record<string, unknown> = {
        kind: "tool_result",
        at,
        durationMs: entry.durationMs,
        callId: entry.callId,
        name: entry.name,
      };
      if (entry.ok !== undefined) record["ok"] = entry.ok;
      if (entry.effect !== undefined) record["effect"] = entry.effect;
      // 失败时 JSONL 与可读行都用 `error=<code>`，与 observation 的 `error` 字段同名。
      if (entry.errorCode !== undefined) record["error"] = entry.errorCode;
      if (reason !== undefined) record["reason"] = clip(reason);
      if (entry.waiting !== undefined) record["waiting"] = entry.waiting;
      if (entry.output !== undefined) record["output"] = clip(entry.output);
      if (entry.policy !== undefined) record["policy"] = entry.policy;

      writeRecord(record);
      if (entry.waiting !== undefined) {
        writeLine(
          [
            `[tool] result callId=${entry.callId}`,
            `name=${entry.name}`,
            `at=${at}`,
            `durationMs=${entry.durationMs}`,
            "status=waiting",
            `requestId=${entry.waiting.requestId}`,
            `reason=${entry.waiting.reason}`,
          ].join(" "),
        );
      } else {
        writeLine(
          [
            `[tool] result callId=${entry.callId}`,
            `name=${entry.name}`,
            `at=${at}`,
            `durationMs=${entry.durationMs}`,
            `ok=${String(entry.ok ?? false)}`,
            `effect=${entry.effect ?? "unknown"}`,
            ...(entry.errorCode === undefined ? [] : [`error=${entry.errorCode}`]),
            // observation 里带可读原因时附上（截断），否则只留错误码。
            ...(reason === undefined ? [] : [`reason=${clip(reason)}`]),
          ].join(" "),
        );
      }
      if (entry.output !== undefined) writeLine(`[tool] output: ${clip(entry.output)}`);
      if (entry.policy !== undefined) writeLine(`[tool] policy: ${JSON.stringify(entry.policy)}`);
    },

    usage(entry) {
      const at = now().toISOString();

      if (entry.scope === "model") {
        const record: Record<string, unknown> = {
          kind: "usage",
          scope: "model",
          at,
          durationMs: entry.durationMs,
          step: entry.step,
          phase: entry.phase,
        };
        // `undefined` 字段不写进 JSONL（JSON.stringify 会跳过）：缺失就是缺失。
        if (entry.modelId !== undefined) record["model"] = entry.modelId;
        if (entry.inputTokens !== undefined) record["inputTokens"] = entry.inputTokens;
        if (entry.outputTokens !== undefined) record["outputTokens"] = entry.outputTokens;
        if (entry.cachedInputTokens !== undefined) {
          record["cachedInputTokens"] = entry.cachedInputTokens;
        }
        if (entry.costUsd !== undefined) record["costUsd"] = entry.costUsd;
        writeRecord(record);
        writeLine(formatModelUsageLine(entry));
        return;
      }

      const record: Record<string, unknown> = {
        kind: "usage",
        scope: "run",
        at,
        durationMs: entry.wallMs,
        modelCalls: entry.modelCalls,
        toolCalls: entry.toolCalls,
        wallMs: entry.wallMs,
      };
      if (entry.inputTokens !== undefined) record["inputTokens"] = entry.inputTokens;
      if (entry.outputTokens !== undefined) record["outputTokens"] = entry.outputTokens;
      if (entry.cachedInputTokens !== undefined) {
        record["cachedInputTokens"] = entry.cachedInputTokens;
      }
      if (entry.costUsd !== undefined) record["costUsd"] = entry.costUsd;
      if (entry.prices !== undefined) record["prices"] = entry.prices;
      if (entry.costBasis !== undefined) record["costBasis"] = entry.costBasis;
      writeRecord(record);
      writeLine(formatRunUsageLine(entry));
    },

    planRevised(entry) {
      writeRecord({
        kind: "plan_revised",
        at: now().toISOString(),
        version: entry.version,
        reason: entry.reason,
        detail: entry.detail,
      });
    },

    budgetExhausted(entry) {
      writeRecord({ kind: "budget_exhausted", at: now().toISOString(), ...entry });
      writeLine(formatBudgetExhaustedLine(entry));
    },

    close() {
      if (closed) return;
      closed = true;
      if (fd !== undefined) closeSync(fd);
    },
  };
}

/** 成本估算接线：模型 id + 价目表。缺失时 `cost=unknown`，绝不按 0 算。 */
export interface JournalModelPricing {
  modelId?: string | undefined;
  table?: PriceTable | undefined;
}

/** 单次调用的用量增量：只用于按次计价，字段缺失即未知。 */
function usageDelta(usage: ModelUsage | undefined, durationMs: number): RunUsage {
  return {
    inputTokens: usage?.inputTokens,
    outputTokens: usage?.outputTokens,
    cachedInputTokens: usage?.cachedInputTokens,
    modelCalls: 1,
    toolCalls: 0,
    durationMs,
  };
}

/**
 * 驱动装饰器：包住真实（或注入的假）`ModelDriver`，在调用前后记录**真实输入与输出**。
 *
 * 第几轮由装饰器自己计数：Loop 只按 step 递增调用 `start` / `continue`，
 * 装饰器不需要反向依赖 Loop 的内部状态。
 *
 * 每次调用结束后额外记一行 `[usage]`（token / 缓存命中 / 耗时 / 模型 / 估算成本）。
 * `pricing` 缺失（没有模型 id）时 `cost=unknown`。
 */
export function createJournalModelDriver(
  inner: ModelDriver,
  journal: Journal,
  pricing: JournalModelPricing = {},
): ModelDriver {
  let step = 0;

  const recordUsage = (input: {
    step: number;
    phase: "start" | "continue";
    turn: ModelTurn;
    durationMs: number;
  }): void => {
    const { turn } = input;
    const durationMs = input.durationMs;
    const costUsd =
      pricing.modelId === undefined
        ? undefined
        : estimateCostUsd(usageDelta(turn.usage, durationMs), pricing.modelId, pricing.table);

    journal.usage({
      scope: "model",
      step: input.step,
      phase: input.phase,
      modelId: pricing.modelId,
      inputTokens: turn.usage?.inputTokens,
      outputTokens: turn.usage?.outputTokens,
      cachedInputTokens: turn.usage?.cachedInputTokens,
      durationMs,
      costUsd,
    });
  };

  return {
    async start({ request, tools }) {
      step += 1;
      const current = step;
      journal.modelRequest({
        step: current,
        phase: "start",
        instructions: request.instructions,
        input: request.input,
        toolNames: tools.map((tool) => tool.name),
      });

      const startedAt = Date.now();
      const turn = await inner.start({ request, tools });
      const durationMs = Date.now() - startedAt;
      journal.modelResponse({
        step: current,
        phase: "start",
        responseId: turn.responseId,
        finalText: turn.finalText,
        reasoning: turn.reasoning,
        toolCalls: turn.toolCalls,
        durationMs,
      });
      recordUsage({ step: current, phase: "start", turn, durationMs });
      return turn;
    },

    async continue(options) {
      step += 1;
      const current = step;
      journal.modelRequest({
        step: current,
        phase: "continue",
        instructions: options.instructions,
        input: options.continuationContext,
        outputs: options.outputs.map((output) => ({
          callId: output.call_id,
          output: output.output,
        })),
        toolNames: options.tools.map((tool) => tool.name),
        previousResponseId: options.previousResponseId,
      });

      const startedAt = Date.now();
      const turn = await inner.continue(options);
      const durationMs = Date.now() - startedAt;
      journal.modelResponse({
        step: current,
        phase: "continue",
        responseId: turn.responseId,
        finalText: turn.finalText,
        reasoning: turn.reasoning,
        toolCalls: turn.toolCalls,
        durationMs,
      });
      recordUsage({ step: current, phase: "continue", turn, durationMs });
      return turn;
    },
  };
}

/** Loop 钩子的输入形状；与 `AgentLoopOptions.onToolCall` 的结构完全一致。 */
export interface JournalToolHookInput {
  call: ToolCall;
  result: ToolExecutionResult;
  durationMs: number;
  policy?: PolicyDecision | undefined;
}

/** 把 Loop 的工具钩子接到 journal：先记调用（参数），再记结果（observation 全文）。 */
export function createJournalToolHook(journal: Journal): (input: JournalToolHookInput) => void {
  return (input) => {
    journal.toolCall({
      callId: input.call.callId,
      name: input.call.name,
      argumentsJson: input.call.argumentsJson,
      durationMs: input.durationMs,
    });

    if (input.result.type === "waiting") {
      journal.toolResult({
        callId: input.call.callId,
        name: input.call.name,
        durationMs: input.durationMs,
        waiting: { requestId: input.result.requestId, reason: input.result.reason },
        policy: input.policy,
      });
      return;
    }

    journal.toolResult({
      callId: input.call.callId,
      name: input.call.name,
      durationMs: input.durationMs,
      ok: input.result.ok,
      effect: input.result.effect,
      errorCode: input.result.errorCode,
      output: input.result.output,
      policy: input.policy,
    });
  };
}
