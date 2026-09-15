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

export interface ModelTurn {
  responseId: string;
  finalText: string;
  toolCalls: ToolCall[];
  /** 交互章扩展：模型请求澄清时，Harness 必须先落盘再停止。 */
  userInputRequest?: UserInputRequest | undefined;
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
    }): Promise<ResponsesResultLike>;
  };
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

export function toModelTurn(response: ResponsesResultLike, now = new Date()): ModelTurn {
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
