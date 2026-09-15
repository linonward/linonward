import { z } from "zod";

import type { ModelRequest } from "./context.js";
import type { UserInputRequest } from "./types.js";

export interface Model {
  generate(request: ModelRequest): Promise<string>;
}

export interface ToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  strict: true;
}

export interface ToolCall {
  callId: string;
  name: string;
  argumentsJson: string;
}

/**
 * provider 返回的原始 token 用量。
 *
 * 字段**全部可选**：字段缺失就是缺失（`undefined`），绝不用 0 冒充未知。
 *
 * 字段名以官方文档为准（`https://api-docs.deepseek.com/api/create-response`，
 * 与 OpenAI Responses API 一致）：
 * - `usage.input_tokens` / `usage.output_tokens` / `usage.total_tokens`；
 * - 缓存命中在 `usage.input_tokens_details.cached_tokens`。
 *
 * 兼容解析：Chat Completions 风格的 `prompt_tokens_details.cached_tokens` 与
 * `prompt_cache_hit_tokens` 也认，因为网关代理可能把两套字段混在一起返回。
 */
export interface ModelUsage {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cachedInputTokens?: number | undefined;
  totalTokens?: number | undefined;
}

export interface ModelTurn {
  responseId: string;
  finalText: string;
  toolCalls: ToolCall[];
  /** 交互章扩展：模型请求澄清时，Harness 必须先落盘再停止。 */
  userInputRequest?: UserInputRequest | undefined;
  /**
   * provider 报告的 token 用量。缺失（老网关、截断的响应等）时保持 `undefined`：
   * Harness 会把它记成 `unknown`，而不是按 0 计入成本。
   */
  usage?: ModelUsage | undefined;
}

export interface FunctionCallOutput {
  type: "function_call_output";
  call_id: string;
  output: string;
}

/** 模型适配器的两个原子操作：首轮与续轮。Loop 只依赖这个接口，不依赖任何厂商 SDK。 */
export interface ModelDriver {
  start(options: { request: ModelRequest; tools: ToolDefinition[] }): Promise<ModelTurn>;
  continue(options: {
    previousResponseId: string;
    instructions: string;
    continuationContext: ModelRequest["input"];
    outputs: FunctionCallOutput[];
    tools: ToolDefinition[];
  }): Promise<ModelTurn>;
}

/**
 * Responses API 的最小结构类型。
 *
 * 真实项目里由 `openai` SDK 满足这个形状；教程 fixture 刻意不引入厂商 SDK，
 * 因此离线测试和类型检查都不需要网络、密钥或额外依赖。
 */
export interface ResponsesResultLike {
  id: string;
  output_text: string;
  output: Array<{
    type: string;
    call_id?: string;
    name?: string;
    arguments?: string;
  }>;
}

/**
 * 已经**归一化**过的响应：`usage` 是 `parseModelUsage` 的结果，而不是 provider 的原始 JSON。
 * `src/responses-http.ts` 的 `normalizeResult` 产出这个形状；`toModelTurn` 只认它。
 */
export interface NormalizedModelResponse extends ResponsesResultLike {
  usage?: ModelUsage | undefined;
}

export interface ResponsesClientLike {
  responses: {
    create(body: {
      model: string;
      instructions?: string;
      input?: unknown;
      previous_response_id?: string;
      tools?: ToolDefinition[];
      tool_choice?: "auto";
      parallel_tool_calls?: boolean;
    }): Promise<NormalizedModelResponse>;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** 从 `{ cached_tokens: n }` 这类对象里读一个可选计数；对象不存在就是未知。 */
function nestedCount(value: unknown, key: string): number | undefined {
  return isRecord(value) ? optionalCount(value[key]) : undefined;
}

/**
 * 宽松解析 provider 的 `usage`：**缺字段就返回 `undefined` 字段，不伪造 0**。
 *
 * 完全没有可用计数时返回 `undefined`，让上层把这次调用记成 `unknown`。
 */
export function parseModelUsage(raw: unknown): ModelUsage | undefined {
  if (!isRecord(raw)) return undefined;

  const usage: ModelUsage = {};
  const inputTokens = optionalCount(raw["input_tokens"]) ?? optionalCount(raw["prompt_tokens"]);
  const outputTokens =
    optionalCount(raw["output_tokens"]) ?? optionalCount(raw["completion_tokens"]);
  const totalTokens = optionalCount(raw["total_tokens"]);
  // 官方 Responses 字段优先；Chat Completions 的两种别名只在官方字段缺失时兜底。
  const cachedInputTokens =
    nestedCount(raw["input_tokens_details"], "cached_tokens") ??
    nestedCount(raw["prompt_tokens_details"], "cached_tokens") ??
    optionalCount(raw["prompt_cache_hit_tokens"]);

  if (inputTokens !== undefined) usage.inputTokens = inputTokens;
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  if (cachedInputTokens !== undefined) usage.cachedInputTokens = cachedInputTokens;
  if (totalTokens !== undefined) usage.totalTokens = totalTokens;

  return Object.keys(usage).length === 0 ? undefined : usage;
}

export const userInputRequestSchema = z
  .object({
    question: z.string().min(1),
    reason: z.string().min(1),
    kind: z.enum(["clarification", "approval", "manual_reconciliation"]).optional(),
    relatedStepId: z.string().min(1).optional(),
  })
  .strict();

/** 保留的澄清调用名。它不会走普通工具权限，也不会在等待前产生副作用。 */
export const REQUEST_USER_INPUT_TOOL_NAME = "request_user_input";

export function toModelTurn(response: NormalizedModelResponse, now = new Date()): ModelTurn {
  const toolCalls: ToolCall[] = [];
  let userInputRequest: UserInputRequest | undefined;

  for (const item of response.output) {
    if (item.type !== "function_call") continue;
    if (!item.call_id || !item.name || item.arguments === undefined) continue;

    if (item.name === REQUEST_USER_INPUT_TOOL_NAME) {
      const parsed = userInputRequestSchema.safeParse(safeJsonParse(item.arguments));
      if (parsed.success) {
        userInputRequest = {
          id: item.call_id,
          kind: parsed.data.kind ?? "clarification",
          question: parsed.data.question,
          reason: parsed.data.reason,
          ...(parsed.data.relatedStepId !== undefined
            ? { relatedStepId: parsed.data.relatedStepId }
            : {}),
          createdAt: now.toISOString(),
        };
        continue;
      }
    }

    toolCalls.push({
      callId: item.call_id,
      name: item.name,
      argumentsJson: item.arguments,
    });
  }

  const turn: ModelTurn = {
    responseId: response.id,
    finalText: response.output_text,
    toolCalls,
  };
  if (userInputRequest !== undefined) turn.userInputRequest = userInputRequest;
  // 缺失就是缺失：`usage` 不存在时不写这个字段，上层据此记 `unknown`。
  if (response.usage !== undefined) turn.usage = response.usage;
  return turn;
}

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function requireModelId(model: string | undefined): string {
  if (!model) throw new Error("缺少 OPENAI_MODEL");
  return model;
}

function baseBody(options: {
  modelId: string;
  instructions: string;
  input: unknown;
  tools: ToolDefinition[];
}): Parameters<ResponsesClientLike["responses"]["create"]>[0] {
  return {
    model: options.modelId,
    instructions: options.instructions,
    input: options.input,
    tools: options.tools,
    tool_choice: "auto",
    parallel_tool_calls: false,
  };
}

export function createOpenAIModel(client: ResponsesClientLike): Model {
  return {
    async generate(request) {
      const response = await client.responses.create({
        model: requireModelId(process.env.OPENAI_MODEL),
        instructions: request.instructions,
        input: request.input,
      });
      return response.output_text;
    },
  };
}

export function createOpenAIModelDriver(options: {
  client: ResponsesClientLike;
  modelId?: string | undefined;
}): ModelDriver {
  const modelId = (): string => requireModelId(options.modelId ?? process.env.OPENAI_MODEL);

  return {
    async start({ request, tools }) {
      const response = await options.client.responses.create(
        baseBody({
          modelId: modelId(),
          instructions: request.instructions,
          input: request.input,
          tools,
        }),
      );
      return toModelTurn(response);
    },
    async continue({ previousResponseId, instructions, continuationContext, outputs, tools }) {
      const response = await options.client.responses.create({
        ...baseBody({
          modelId: modelId(),
          instructions,
          input: [...outputs, ...continuationContext],
          tools,
        }),
        previous_response_id: previousResponseId,
      });
      return toModelTurn(response);
    },
  };
}
