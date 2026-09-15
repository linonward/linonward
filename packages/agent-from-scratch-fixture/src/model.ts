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
  /**
   * 可见推理（思维链）：每个 `reasoning` 输出 item 产出一个数组元素，元素内部是该
   * item 的 `content[].text`（分片类型 `reasoning_text`）按出现顺序的拼接。
   * **与 `finalText` 严格分离**：推理文本不参与上下文、也不会被当成最终答案。
   *
   * 模型没有返回 reasoning item 时保持 `undefined`——缺失就是缺失，不用空数组冒充。
   */
  reasoning?: string[] | undefined;
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
 * 一条输出 item 的内容分片。
 *
 * `message` item 的正文放在 `text`（配合 `type: "output_text"`），`reasoning` item 的
 * 可见推理**同样**放在 `text`（配合 `type: "reasoning_text"`）。两个字段相同、靠 `type`
 * 区分，这正是真实抓包的形状（与 OpenAI Responses API 一致）；聚合 `output_text` 时
 * 只认 `output_text` 分片，思维链因此不会混进 `finalText`。
 */
export interface ModelResponseContentPart {
  type?: string | undefined;
  text?: string | undefined;
  reasoning_text?: string | undefined;
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
    /** 只有 `message` / `reasoning` item 带内容分片；其它 item 缺失该字段。 */
    content?: readonly ModelResponseContentPart[] | undefined;
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

/**
 * 取一个 reasoning 正文分片的文本。
 *
 * **正文在 `text` 字段**，分片类型是 `reasoning_text`——这与 message 的 `output_text`
 * 分片同形（真实抓包：
 * `{"type":"reasoning_text","text":"We need answer user asks ..."}`）。
 * 只有 `type` 不是 `reasoning_text` 的分片（例如 `summary_text` 摘要）才必须跳过：
 * 摘要是 provider 的二次加工，混进思维链就是伪造。
 *
 * `reasoning_text` 作为字段名保留兼容：早期版本按这个名字解析，个别网关也会这么回。
 * 但它只是兜底，不是主路径——主路径认 `text`。
 */
function reasoningPartText(part: unknown): string {
  if (!isRecord(part)) return "";
  const kind = part["type"];
  if (typeof kind === "string" && kind !== "reasoning_text") return "";
  if (typeof part["text"] === "string") return part["text"];
  return typeof part["reasoning_text"] === "string" ? part["reasoning_text"] : "";
}

/**
 * 从归一化响应的 `reasoning` items 里聚合可见推理。
 *
 * 每个 `reasoning` item 产出一个数组元素（该 item 所有正文分片按顺序拼接）；
 * 没有 reasoning item、或全部为空文本时返回 `undefined`。**缺失就是缺失**：
 * 不返回 `[]`，因为"模型没给推理"和"模型给了空推理"在观测上是同一件事，
 * 上层只需要一个 `undefined` 就能区分"没有"与"有内容"。
 */
export function collectReasoning(
  output: readonly ResponsesResultLike["output"][number][],
): string[] | undefined {
  const blocks: string[] = [];

  for (const item of output) {
    if (item.type !== "reasoning") continue;
    const content = item.content;
    if (!Array.isArray(content)) continue;

    const text = content.map(reasoningPartText).join("");
    if (text.length > 0) blocks.push(text);
  }

  return blocks.length === 0 ? undefined : blocks;
}

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
  // 思维链与 finalText 严格分离，且只在真的拿到非空推理时才写这个字段。
  const reasoning = collectReasoning(response.output);
  if (reasoning !== undefined) turn.reasoning = reasoning;
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
