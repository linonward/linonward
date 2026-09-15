import { describe, expect, it } from "vitest";

import { buildModelRequest } from "../src/context.js";
import { FakeModel } from "../src/fake-model.js";
import {
  type NormalizedModelResponse,
  parseModelUsage,
  type ResponsesResultLike,
  toModelTurn,
} from "../src/model.js";
import { createModel } from "../src/model-factory.js";

describe("offline model path", () => {
  it("returns scripted replies through the shared Model interface", async () => {
    const model = new FakeModel(["模型已连接"]);
    const request = buildModelRequest({
      task: "只回复：模型已连接",
      cwd: "/workspace",
      toolNames: [],
      sources: [],
    });

    await expect(model.generate(request)).resolves.toBe("模型已连接");
  });

  it("keeps the default factory offline and rejects unknown modes", () => {
    expect(createModel({ fakeReplies: ["ok"] })).toBeInstanceOf(FakeModel);

    const previous = process.env.MODEL_MODE;
    process.env.MODEL_MODE = "nope";
    try {
      expect(() => createModel()).toThrow("不支持的 MODEL_MODE: nope");
    } finally {
      if (previous === undefined) delete process.env.MODEL_MODE;
      else process.env.MODEL_MODE = previous;
    }
  });

  it("extracts every function call from a mixed model output", () => {
    const response: ResponsesResultLike = {
      id: "response-1",
      output_text: "我先读取文件。",
      output: [
        { type: "message" },
        { type: "function_call", call_id: "call-1", name: "read_file", arguments: '{"path":"a"}' },
        { type: "function_call", call_id: "call-2", name: "search_text", arguments: '{"q":"b"}' },
      ],
    };

    expect(toModelTurn(response)).toEqual({
      responseId: "response-1",
      finalText: "我先读取文件。",
      toolCalls: [
        { callId: "call-1", name: "read_file", argumentsJson: '{"path":"a"}' },
        { callId: "call-2", name: "search_text", argumentsJson: '{"q":"b"}' },
      ],
    });
  });

  it("turns a reserved request_user_input call into a userInputRequest", () => {
    const now = new Date("2024-01-01T00:00:00.000Z");
    const response: ResponsesResultLike = {
      id: "response-2",
      output_text: "",
      output: [
        {
          type: "function_call",
          call_id: "call-ask",
          name: "request_user_input",
          arguments: JSON.stringify({
            question: "--name 未提供时使用哪个默认值？",
            reason: "缺少关键产品选择",
            kind: "clarification",
          }),
        },
      ],
    };

    const turn = toModelTurn(response, now);

    expect(turn.toolCalls).toEqual([]);
    expect(turn.userInputRequest).toEqual({
      id: "call-ask",
      kind: "clarification",
      question: "--name 未提供时使用哪个默认值？",
      reason: "缺少关键产品选择",
      createdAt: now.toISOString(),
    });
  });

  it("keeps malformed clarification calls as ordinary tool calls so they become observations", () => {
    const response: ResponsesResultLike = {
      id: "response-3",
      output_text: "",
      output: [
        {
          type: "function_call",
          call_id: "call-bad",
          name: "request_user_input",
          arguments: '{"question":""}',
        },
      ],
    };

    const turn = toModelTurn(response);

    expect(turn.userInputRequest).toBeUndefined();
    expect(turn.toolCalls.map((call) => call.callId)).toEqual(["call-bad"]);
  });

  it("carries normalized usage onto the turn and leaves it absent when unknown", () => {
    const withUsage: NormalizedModelResponse = {
      id: "response-usage",
      output_text: "done",
      output: [],
      usage: { inputTokens: 1234, outputTokens: 256, cachedInputTokens: 1024, totalTokens: 1490 },
    };

    expect(toModelTurn(withUsage).usage).toEqual({
      inputTokens: 1234,
      outputTokens: 256,
      cachedInputTokens: 1024,
      totalTokens: 1490,
    });
    // 缺失就是缺失：turn 上不该出现 `usage` 键，上层据此记 `unknown`。
    expect(toModelTurn({ id: "r", output_text: "x", output: [] })).not.toHaveProperty("usage");
  });

  it("parses provider usage tolerantly without fabricating zeros", () => {
    // 官方 Responses 字段。
    expect(
      parseModelUsage({
        input_tokens: 10,
        input_tokens_details: { cached_tokens: 4 },
        output_tokens: 2,
        total_tokens: 12,
      }),
    ).toEqual({ inputTokens: 10, outputTokens: 2, cachedInputTokens: 4, totalTokens: 12 });

    // Chat Completions 别名（网关可能混用）。
    expect(
      parseModelUsage({ prompt_tokens: 10, completion_tokens: 2, prompt_cache_hit_tokens: 4 }),
    ).toEqual({ inputTokens: 10, outputTokens: 2, cachedInputTokens: 4 });

    // 字段缺失保持缺失；无法识别的形状整体视为未知。
    expect(parseModelUsage({ input_tokens: 7 })).toEqual({ inputTokens: 7 });
    expect(parseModelUsage(undefined)).toBeUndefined();
    expect(parseModelUsage("n/a")).toBeUndefined();
    expect(parseModelUsage({})).toBeUndefined();
    expect(parseModelUsage({ input_tokens: -1 })).toBeUndefined();
  });
});
