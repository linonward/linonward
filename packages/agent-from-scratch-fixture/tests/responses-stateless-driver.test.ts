import { describe, expect, it } from "vitest";

import type { ModelRequest } from "../src/context.js";
import { toModelTurn, type ResponsesResultLike, type ToolDefinition } from "../src/model.js";
import { createStatelessResponsesDriver } from "../src/responses-stateless-driver.js";
import type { ResponsesHttpBody } from "../src/responses-http.js";

const MODEL_ID = "deepseek-v4-flash";

const TOOLS: ToolDefinition[] = [
  {
    type: "function",
    name: "read_file",
    description: "Read one file.",
    parameters: { type: "object", properties: { path: { type: "string" } } },
    strict: true,
  },
];

const REQUEST: ModelRequest = {
  instructions: "system prompt",
  input: [
    { role: "user", content: "读取 package.json" },
    { role: "user", content: "<context_sources></context_sources>" },
  ],
};

function scriptedClient(replies: ResponsesResultLike[]): {
  client: { responses: { create(body: ResponsesHttpBody): Promise<ResponsesResultLike> } };
  bodies: ResponsesHttpBody[];
} {
  const bodies: ResponsesHttpBody[] = [];
  return {
    bodies,
    client: {
      responses: {
        async create(body) {
          bodies.push(body);
          const next = replies.shift();
          if (!next) throw new Error("scripted client ran out of responses");
          return next;
        },
      },
    },
  };
}

function functionCallTurn(
  id: string,
  calls: Array<{ callId: string; name: string; arguments: string }>,
): ResponsesResultLike {
  return {
    id,
    output_text: "",
    output: calls.map((call) => ({
      type: "function_call",
      call_id: call.callId,
      name: call.name,
      arguments: call.arguments,
    })),
  };
}

/**
 * 无状态服务端的硬约束：请求里出现的每个 `function_call` 都必须有配对的
 * `function_call_output`。真实调用违反它时返回 400 `No tool output found for tool call ...`。
 */
function assertEveryFunctionCallHasOutput(items: unknown[]): void {
  const outputs = new Set(
    items
      .filter((item): item is { type: string; call_id: string } => {
        const value = item as { type?: unknown; call_id?: unknown };
        return value.type === "function_call_output" && typeof value.call_id === "string";
      })
      .map((item) => item.call_id),
  );

  for (const item of items) {
    const value = item as { type?: unknown; call_id?: unknown };
    if (value.type !== "function_call") continue;
    expect(typeof value.call_id).toBe("string");
    expect(outputs.has(String(value.call_id))).toBe(true);
  }
}

describe("stateless DeepSeek Responses driver", () => {
  it("sends the first turn without previous_response_id", async () => {
    const { client, bodies } = scriptedClient([functionCallTurn("resp-1", [])]);
    const driver = createStatelessResponsesDriver({ client, modelId: MODEL_ID });

    await driver.start({ request: REQUEST, tools: TOOLS });

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty("previous_response_id");
    expect(bodies[0]).not.toHaveProperty("store");
    expect(bodies[0]?.model).toBe(MODEL_ID);
    expect(bodies[0]?.instructions).toBe("system prompt");
    expect(bodies[0]?.input).toEqual(REQUEST.input);
  });

  it("strips the unsupported strict flag from tool definitions", async () => {
    const { client, bodies } = scriptedClient([functionCallTurn("resp-1", [])]);
    const driver = createStatelessResponsesDriver({ client, modelId: MODEL_ID });

    await driver.start({ request: REQUEST, tools: TOOLS });

    expect(bodies[0]?.tools).toEqual([
      {
        type: "function",
        name: "read_file",
        description: "Read one file.",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ]);
    expect(JSON.stringify(bodies[0]?.tools)).not.toContain("strict");
  });

  it("replays the accumulated function_call before the matching output and the new context", async () => {
    const first = functionCallTurn("resp-1", [
      { callId: "call-1", name: "read_file", arguments: '{"path":"package.json"}' },
    ]);
    const second = functionCallTurn("resp-2", []);
    const { client, bodies } = scriptedClient([first, second]);
    const driver = createStatelessResponsesDriver({ client, modelId: MODEL_ID });

    const firstTurn = await driver.start({ request: REQUEST, tools: TOOLS });
    expect(firstTurn.toolCalls).toEqual([
      { callId: "call-1", name: "read_file", argumentsJson: '{"path":"package.json"}' },
    ]);

    const outputs = [
      {
        type: "function_call_output" as const,
        call_id: "call-1",
        output: '{"ok":true,"data":{"content":"pnpm"}}',
      },
    ];
    const continuationContext: ModelRequest["input"] = [
      { role: "user", content: "继续：这是新的上下文" },
    ];

    const secondTurn = await driver.continue({
      previousResponseId: "resp-1",
      instructions: "system prompt",
      continuationContext,
      outputs,
      tools: TOOLS,
    });

    expect(secondTurn.toolCalls).toEqual([]);
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).not.toHaveProperty("previous_response_id");
    expect(bodies[1]?.input).toEqual([
      ...REQUEST.input,
      ...first.output,
      ...outputs,
      ...continuationContext,
    ]);

    // 顺序也要对：function_call 必须紧邻在它的 output 之前出现。
    const items = bodies[1]?.input;
    if (!Array.isArray(items)) throw new Error("expected an array input");
    const callIndex = items.findIndex(
      (item) => (item as { type?: string }).type === "function_call",
    );
    const outputIndex = items.findIndex(
      (item) => (item as { type?: string }).type === "function_call_output",
    );
    expect(callIndex).toBeGreaterThanOrEqual(0);
    expect(outputIndex).toBe(callIndex + 1);
  });

  it("keeps accumulating function calls across three turns", async () => {
    const first = functionCallTurn("resp-1", [
      { callId: "call-1", name: "read_file", arguments: "{}" },
    ]);
    const second = functionCallTurn("resp-2", [
      { callId: "call-2", name: "search_text", arguments: '{"query":"pnpm"}' },
    ]);
    const third = functionCallTurn("resp-3", []);
    const { client, bodies } = scriptedClient([first, second, third]);
    const driver = createStatelessResponsesDriver({ client, modelId: MODEL_ID });

    await driver.start({ request: REQUEST, tools: TOOLS });
    await driver.continue({
      previousResponseId: "resp-1",
      instructions: "system prompt",
      continuationContext: [],
      outputs: [{ type: "function_call_output", call_id: "call-1", output: "o1" }],
      tools: TOOLS,
    });
    await driver.continue({
      previousResponseId: "resp-2",
      instructions: "system prompt",
      continuationContext: [],
      outputs: [{ type: "function_call_output", call_id: "call-2", output: "o2" }],
      tools: TOOLS,
    });

    expect(bodies).toHaveLength(3);
    // 服务端要求每个 function_call 都能在同一次请求里找到它的 function_call_output，
    // 所以历史必须同时保留两轮的工具结果，而不是只带当前这一批。
    expect(bodies[2]?.input).toEqual([
      ...REQUEST.input,
      ...first.output,
      { type: "function_call_output", call_id: "call-1", output: "o1" },
      ...second.output,
      { type: "function_call_output", call_id: "call-2", output: "o2" },
    ]);

    // 真实调用曾因此报 400：`No tool output found for tool call ...`。
    // 这里对每一次请求都强制"调用与结果配对"的不变量。
    for (const body of bodies) {
      const items = body.input;
      if (!Array.isArray(items)) throw new Error("expected an array input");
      assertEveryFunctionCallHasOutput(items);
    }
  });

  it("surfaces request_user_input through the shared toModelTurn parser", async () => {
    const response: ResponsesResultLike = {
      id: "resp-ask",
      output_text: "",
      output: [
        {
          type: "function_call",
          call_id: "call-ask",
          name: "request_user_input",
          arguments: JSON.stringify({ question: "用哪个包管理器？", reason: "缺少关键选择" }),
        },
      ],
    };
    const { client } = scriptedClient([response]);
    const driver = createStatelessResponsesDriver({ client, modelId: MODEL_ID });

    const turn = await driver.start({ request: REQUEST, tools: TOOLS });

    expect(turn.userInputRequest?.question).toBe("用哪个包管理器？");
    expect(turn.toolCalls).toEqual([]);
    expect(toModelTurn(response).userInputRequest?.reason).toBe("缺少关键选择");
  });
});
