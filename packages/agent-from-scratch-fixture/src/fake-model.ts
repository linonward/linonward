import type { ModelRequest } from "./context.js";
import type { FunctionCallOutput, Model, ModelDriver, ModelTurn, ToolDefinition } from "./model.js";
import type { UserInputRequest } from "./types.js";

/** 确定性的模型替身：不读 API Key、不访问网络、不产生费用。 */
export class FakeModel implements Model {
  /** 记录每个请求，测试可以断言装配后的 ModelRequest 真的到达了模型边界。 */
  readonly requests: ModelRequest[] = [];

  constructor(private readonly replies: string[]) {}

  async generate(request: ModelRequest): Promise<string> {
    this.requests.push(request);

    const reply = this.replies.shift();
    if (!reply) throw new Error("fake_model_has_no_reply");
    return reply;
  }
}

export interface RecordedTurn {
  kind: "start" | "continue";
  request: unknown;
}

/** 按脚本返回 turn 的驱动替身，用于离线测试完整控制流。 */
export class FakeModelDriver implements ModelDriver {
  readonly turns: RecordedTurn[] = [];
  readonly calls: Array<Parameters<ModelDriver["continue"]>[0]> = [];

  constructor(private readonly scripted: ModelTurn[]) {}

  async start(options: { request: ModelRequest; tools: ToolDefinition[] }): Promise<ModelTurn> {
    this.turns.push({ kind: "start", request: options.request });
    return this.next();
  }

  async continue(options: {
    previousResponseId: string;
    instructions: string;
    continuationContext: ModelRequest["input"];
    outputs: FunctionCallOutput[];
    tools: ToolDefinition[];
  }): Promise<ModelTurn> {
    this.turns.push({ kind: "continue", request: options.continuationContext });
    this.calls.push(options);
    return this.next();
  }

  get remaining(): number {
    return this.scripted.length;
  }

  private next(): ModelTurn {
    const turn = this.scripted.shift();
    if (!turn) throw new Error("fake_driver_has_no_turn");
    return turn;
  }
}

/** responseId 由 callId 派生，避免随机数破坏测试确定性。 */
export function turnWithTools(...toolCalls: ModelTurn["toolCalls"]): ModelTurn {
  return {
    responseId: `response-tools:${toolCalls.map((call) => call.callId).join(",")}`,
    finalText: "",
    toolCalls,
  };
}

export function textTurn(text: string, responseId = "response-text"): ModelTurn {
  return {
    responseId,
    finalText: text,
    toolCalls: [],
  };
}

export function userInputTurn(
  request: UserInputRequest,
  responseId = "response-user-input",
): ModelTurn {
  return {
    responseId,
    finalText: "",
    toolCalls: [],
    userInputRequest: request,
  };
}
