import { describe, expect, it } from "vitest";

import type { ModelUsage } from "../src/model.js";
import {
  createResponsesHttpClient,
  createResponsesModel,
  DEEPSEEK_DEFAULTS,
  ResponsesHttpError,
  resolveDeepSeekConfig,
} from "../src/responses-http.js";

const FAKE_KEY = "sk-test-not-a-real-key";

interface CapturedRequest {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** 按顺序返回预设响应；同时记录每一次请求，供断言 URL / 头 / body。 */
function fakeFetch(responses: Response[]): { impl: typeof fetch; requests: CapturedRequest[] } {
  const requests: CapturedRequest[] = [];

  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof URL ? input.href : String(input);
    const request = input instanceof Request ? input : undefined;
    const rawHeaders = init?.headers ?? request?.headers;
    const headers = new Headers(rawHeaders);
    const rawBody = init?.body;

    requests.push({
      url,
      method: init?.method,
      headers: {
        authorization: headers.get("authorization") ?? "",
        "content-type": headers.get("content-type") ?? "",
      },
      body: typeof rawBody === "string" ? (JSON.parse(rawBody) as Record<string, unknown>) : {},
    });

    const next = responses.shift();
    if (!next) throw new Error("fake fetch ran out of scripted responses");
    return next;
  }) as typeof fetch;

  return { impl, requests };
}

function successResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

const ANSWER_PAYLOAD = {
  id: "resp-1",
  object: "response",
  output: [
    {
      type: "reasoning",
      summary: [],
    },
    {
      type: "message",
      role: "assistant",
      content: [
        { type: "output_text", text: "第一段。" },
        { type: "refusal", refusal: "n/a" },
        { type: "output_text", text: "第二段。" },
      ],
    },
  ],
};

describe("DeepSeek Responses HTTP client", () => {
  it("posts to {baseUrl}/responses with bearer auth and the caller body", async () => {
    const { impl, requests } = fakeFetch([successResponse(ANSWER_PAYLOAD)]);
    const client = createResponsesHttpClient({
      apiKey: FAKE_KEY,
      baseUrl: "https://example.test/v1/",
      fetchImpl: impl,
    });

    const result = await client.responses.create({
      model: DEEPSEEK_DEFAULTS.model,
      instructions: "you are a planner",
      input: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", name: "read_file", description: "d", parameters: {} }],
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://example.test/v1/responses");
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.headers["authorization"]).toBe(`Bearer ${FAKE_KEY}`);
    expect(requests[0]?.headers["content-type"]).toBe("application/json");
    expect(requests[0]?.body).toEqual({
      model: DEEPSEEK_DEFAULTS.model,
      instructions: "you are a planner",
      input: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", name: "read_file", description: "d", parameters: {} }],
    });
    expect(requests[0]?.body).not.toHaveProperty("previous_response_id");
    expect(requests[0]?.body).not.toHaveProperty("store");

    expect(result.id).toBe("resp-1");
    expect(result.output_text).toBe("第一段。第二段。");
    expect(result.output).toEqual(ANSWER_PAYLOAD.output);
    expect(result.output).toHaveLength(2);
  });

  it("returns an empty output_text when no output_text block exists", async () => {
    const { impl } = fakeFetch([
      successResponse({
        id: "resp-2",
        output: [{ type: "function_call", call_id: "c1", name: "read_file", arguments: "{}" }],
      }),
    ]);
    const client = createResponsesHttpClient({ apiKey: FAKE_KEY, fetchImpl: impl });

    const result = await client.responses.create({ model: "deepseek-v4-flash" });

    expect(result.output_text).toBe("");
    expect(result.output).toEqual([
      { type: "function_call", call_id: "c1", name: "read_file", arguments: "{}" },
    ]);
  });

  it("retries 429 and succeeds on the next attempt", async () => {
    const { impl, requests } = fakeFetch([
      new Response(JSON.stringify({ error: "rate limited" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "0" },
      }),
      successResponse(ANSWER_PAYLOAD),
    ]);
    const client = createResponsesHttpClient({
      apiKey: FAKE_KEY,
      baseUrl: "https://example.test/v1",
      fetchImpl: impl,
      maxRetries: 2,
    });

    const result = await client.responses.create({ model: "deepseek-v4-flash" });

    expect(requests).toHaveLength(2);
    expect(result.id).toBe("resp-1");
  });

  it("stops retrying after maxRetries and throws the last 5xx error", async () => {
    const { impl, requests } = fakeFetch([
      errorResponse(503, "upstream down"),
      errorResponse(503, "upstream down"),
    ]);
    const client = createResponsesHttpClient({
      apiKey: FAKE_KEY,
      fetchImpl: impl,
      maxRetries: 1,
    });

    await expect(client.responses.create({ model: "deepseek-v4-flash" })).rejects.toThrow(
      ResponsesHttpError,
    );
    expect(requests).toHaveLength(2);
  });

  it("does not retry 400 and surfaces the status code with the response body", async () => {
    const { impl, requests } = fakeFetch([
      errorResponse(400, JSON.stringify({ error: { message: "context length exceeded" } })),
    ]);
    const client = createResponsesHttpClient({
      apiKey: FAKE_KEY,
      baseUrl: "https://example.test/v1",
      fetchImpl: impl,
      maxRetries: 3,
    });

    const error = await client.responses
      .create({ model: "deepseek-v4-flash" })
      .catch((caught: unknown) => caught);

    expect(requests).toHaveLength(1);
    expect(error).toBeInstanceOf(ResponsesHttpError);
    if (!(error instanceof ResponsesHttpError)) throw new Error("expected ResponsesHttpError");
    expect(error.status).toBe(400);
    expect(error.body).toContain("context length exceeded");
    expect(error.message).toContain("400");
    expect(error.message).toContain("context length exceeded");
  });

  it("resolves config from env with DeepSeek defaults and never echoes the key", () => {
    expect(resolveDeepSeekConfig({ DEEPSEEK_API_KEY: FAKE_KEY })).toEqual({
      apiKey: FAKE_KEY,
      baseUrl: DEEPSEEK_DEFAULTS.baseUrl,
      model: DEEPSEEK_DEFAULTS.model,
      plannerModel: DEEPSEEK_DEFAULTS.model,
    });

    expect(
      resolveDeepSeekConfig({
        DEEPSEEK_API_KEY: FAKE_KEY,
        DEEPSEEK_BASE_URL: "https://proxy.test/v1",
        DEEPSEEK_MODEL: "deepseek-v4-pro",
      }),
    ).toEqual({
      apiKey: FAKE_KEY,
      baseUrl: "https://proxy.test/v1",
      model: "deepseek-v4-pro",
      // 没设 DEEPSEEK_PLANNER_MODEL 时规划模型回落到循环模型。
      plannerModel: "deepseek-v4-pro",
    });

    let thrown: unknown;
    try {
      resolveDeepSeekConfig({});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) throw new Error("expected Error");
    expect(thrown.message).toContain("DEEPSEEK_API_KEY");
    expect(thrown.message).not.toContain(FAKE_KEY);
    expect(thrown.message).not.toContain("sk-");
  });

  it("lets DEEPSEEK_PLANNER_MODEL override only the planning model", () => {
    expect(
      resolveDeepSeekConfig({
        DEEPSEEK_API_KEY: FAKE_KEY,
        DEEPSEEK_MODEL: "deepseek-v4-flash",
        DEEPSEEK_PLANNER_MODEL: "deepseek-v4-pro",
      }),
    ).toEqual({
      apiKey: FAKE_KEY,
      baseUrl: DEEPSEEK_DEFAULTS.baseUrl,
      model: "deepseek-v4-flash",
      plannerModel: "deepseek-v4-pro",
    });
  });

  it("rejects an empty apiKey at construction time without echoing a key", () => {
    let thrown: unknown;
    try {
      createResponsesHttpClient({ apiKey: "" });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) throw new Error("expected Error");
    expect(thrown.message).toContain("apiKey");
    expect(thrown.message).not.toContain(FAKE_KEY);
  });

  it("exposes the normalized result as a Model for the planner", async () => {
    const { impl, requests } = fakeFetch([successResponse(ANSWER_PAYLOAD)]);
    const client = createResponsesHttpClient({ apiKey: FAKE_KEY, fetchImpl: impl });
    const model = createResponsesModel({ client, modelId: DEEPSEEK_DEFAULTS.model });

    await expect(
      model.generate({ instructions: "plan please", input: [{ role: "user", content: "go" }] }),
    ).resolves.toBe("第一段。第二段。");

    expect(requests[0]?.body["model"]).toBe(DEEPSEEK_DEFAULTS.model);
    expect(requests[0]?.body["instructions"]).toBe("plan please");
    expect(requests[0]?.body).not.toHaveProperty("tools");
  });

  /**
   * 字段名以官方 Responses 文档为准：
   * `usage.input_tokens` / `output_tokens` / `total_tokens`，
   * 缓存命中在 `usage.input_tokens_details.cached_tokens`。
   */
  it("normalizes provider usage into camelCase token counts", async () => {
    const { impl } = fakeFetch([
      successResponse({
        ...ANSWER_PAYLOAD,
        usage: {
          input_tokens: 1234,
          input_tokens_details: { cached_tokens: 1024 },
          output_tokens: 256,
          output_tokens_details: { reasoning_tokens: 128 },
          total_tokens: 1490,
        },
      }),
    ]);
    const client = createResponsesHttpClient({ apiKey: FAKE_KEY, fetchImpl: impl });

    const result = await client.responses.create({ model: DEEPSEEK_DEFAULTS.model });

    expect(result.usage).toEqual({
      inputTokens: 1234,
      outputTokens: 256,
      cachedInputTokens: 1024,
      totalTokens: 1490,
    });
  });

  it("keeps missing usage fields missing instead of fabricating zeros", async () => {
    const { impl } = fakeFetch([
      // 只有 input 计数：其余字段必须保持"缺失"，不能补 0。
      successResponse({ ...ANSWER_PAYLOAD, usage: { input_tokens: 7 } }),
      // 完全没有 usage：结果里就不该有 usage。
      successResponse(ANSWER_PAYLOAD),
      // 形状不认识：同样视为缺失。
      successResponse({ ...ANSWER_PAYLOAD, usage: "n/a" }),
    ]);
    const client = createResponsesHttpClient({ apiKey: FAKE_KEY, fetchImpl: impl });

    const partial = await client.responses.create({ model: DEEPSEEK_DEFAULTS.model });
    expect(partial.usage).toEqual({ inputTokens: 7 });
    expect(partial.usage?.outputTokens).toBeUndefined();
    expect(partial.usage?.cachedInputTokens).toBeUndefined();

    const absent = await client.responses.create({ model: DEEPSEEK_DEFAULTS.model });
    expect(absent.usage).toBeUndefined();

    const malformed = await client.responses.create({ model: DEEPSEEK_DEFAULTS.model });
    expect(malformed.usage).toBeUndefined();
  });

  it("hands planner usage to the caller through onUsage (undefined when absent)", async () => {
    const reported: Array<ModelUsage | undefined> = [];
    const { impl } = fakeFetch([
      successResponse({ ...ANSWER_PAYLOAD, usage: { input_tokens: 7, output_tokens: 3 } }),
      successResponse(ANSWER_PAYLOAD),
    ]);
    const client = createResponsesHttpClient({ apiKey: FAKE_KEY, fetchImpl: impl });
    const model = createResponsesModel({
      client,
      modelId: DEEPSEEK_DEFAULTS.model,
      onUsage: (usage) => void reported.push(usage),
    });

    await model.generate({ instructions: "a", input: [] });
    await model.generate({ instructions: "b", input: [] });

    expect(reported).toEqual([{ inputTokens: 7, outputTokens: 3 }, undefined]);
  });
});
