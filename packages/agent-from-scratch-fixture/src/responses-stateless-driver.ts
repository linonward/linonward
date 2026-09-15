import type { ModelDriver, ModelTurn, ToolDefinition } from "./model.js";
import { toModelTurn } from "./model.js";
import type { ResponseResult } from "./responses-http.js";

/**
 * 驱动只需要 `responses.create`。这里刻意不复用 `ResponsesClientLike`：它的
 * `tools` 参数类型带 `strict`，而 DeepSeek 要求剥掉该字段。`createResponsesHttpClient`
 * 与手写结构替身都满足这个更窄的接口。
 */
export interface StatelessResponsesClient {
  responses: {
    create(body: {
      model: string;
      instructions?: string;
      input?: unknown;
      tools?: readonly unknown[];
      tool_choice?: string;
    }): Promise<ResponseResult>;
  };
}

export interface StatelessResponsesDriverOptions {
  client: StatelessResponsesClient;
  modelId: string;
}

/** 发送给模型的扁平工具定义：剥掉 `strict`（DeepSeek 未见文档支持该字段）。 */
export type StatelessToolDefinition = Omit<ToolDefinition, "strict">;

/**
 * DeepSeek 的 `tools` 只接受 `{type:"function", name, description, parameters}` 扁平结构。
 * 现有 `ToolDefinition` 恰好是这个形状再加一个 `strict`，所以这里只做减法。
 */
export function stripStrict(tools: ToolDefinition[]): StatelessToolDefinition[] {
  return tools.map((tool) => ({
    type: tool.type,
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

/**
 * 无状态 `ModelDriver`。
 *
 * **为什么必须自己累积历史**：DeepSeek 的 Responses API 不保存任何会话状态，
 * `previous_response_id`、`conversation`、`store` 都会被静默忽略——不是报错，是当没看见。
 * 如果像 `createOpenAIModelDriver` 那样只发 `previous_response_id`，模型每轮都只会看到
 * 最后一批 `function_call_output`，配对不到对应的 `function_call`，多轮任务必然失败。
 *
 * 客户端维护的历史包含三类条目，且**工具结果也必须记进来**：
 * 1. 初始 `ModelRequest.input`；
 * 2. 每次响应的全部 `output` items（含 `function_call`）；
 * 3. 每次续轮送出的 `function_call_output` items。
 *
 * 第 3 类不能省：服务端要求**每个 `function_call` 都能在同一次请求里找到它的
 * `function_call_output`**。只在当轮发送是不够的——下一轮仍会带着旧的 `function_call`，
 * 若它的输出不在请求里，服务端直接 400（`No tool output found for tool call ...`）。
 *
 * `continuationContext` 只随最新一轮发送、不进历史：它是每轮重新组装的最新状态
 * （计划、Skill、Harness 反馈、以及累计的 observation），本身已经覆盖了此前的内容，
 * 重复累积只会白白撑大上下文。
 */
export function createStatelessResponsesDriver(
  options: StatelessResponsesDriverOptions,
): ModelDriver {
  /** 初始输入 + 所有响应 output items + 所有已送出的 function_call_output items。 */
  let history: unknown[] = [];

  const create = async (body: {
    instructions: string;
    input: unknown[];
    tools: ToolDefinition[];
  }): Promise<ModelTurn> => {
    const response = await options.client.responses.create({
      model: options.modelId,
      instructions: body.instructions,
      input: body.input,
      tools: stripStrict(body.tools),
    });

    history = [...history, ...response.output];
    // `toModelTurn` 同时把归一化后的 `usage` 带到 `ModelTurn` 上：provider 没给
    // usage 时该字段缺失（`undefined`），Loop 会把它记成 unknown 而不是 0。
    return toModelTurn(response);
  };

  return {
    async start({ request, tools }): Promise<ModelTurn> {
      history = [...request.input];
      return create({
        instructions: request.instructions,
        input: history,
        tools,
      });
    },

    /**
     * `previousResponseId` 被有意忽略：DeepSeek 无状态，发它也不会生效，
     * 历史只能由客户端重发。保留参数只是为了满足 `ModelDriver` 契约。
     */
    async continue({ instructions, continuationContext, outputs, tools }): Promise<ModelTurn> {
      history = [...history, ...outputs];
      return create({
        instructions,
        input: [...history, ...continuationContext],
        tools,
      });
    },
  };
}
