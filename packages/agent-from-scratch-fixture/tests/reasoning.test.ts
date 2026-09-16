import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createJournal,
  createJournalModelDriver,
  DEFAULT_JOURNAL_MAX_CHARACTERS,
} from "../src/cli-journal.js";
import {
  collectReasoning,
  type ModelDriver,
  type ResponsesResultLike,
  type ToolDefinition,
  toModelTurn,
} from "../src/model.js";
import { createResponsesHttpClient } from "../src/responses-http.js";
import { makeTempDir, removeTempDir } from "./support.js";

function collector(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => void lines.push(line) };
}

/**
 * DeepSeek（与 OpenAI 同形）的 reasoning item：正文分片是
 * `{ type: "reasoning_text", text }`——**字段名是 `text`**，和普通 message 分片一致。
 * 真实抓包的形状见下方 `recordedReasoningPayload`。
 */
function reasoningItem(...parts: string[]): ResponsesResultLike["output"][number] {
  return {
    type: "reasoning",
    content: parts.map((text) => ({ type: "reasoning_text", text })),
  };
}

/**
 * 真实抓包（`POST https://api.deepseek.com/v1/responses`，`deepseek-v4-pro`，
 * 带 `tools` 的一轮）里的 reasoning item。刻意保留 provider 自己的字段顺序与
 * `summary` / `encrypted_content` 噪声，防止解析逻辑再次对着臆想的字段名写。
 */
const recordedReasoningPayload = {
  type: "reasoning",
  id: "f08a962c-53ba-4b02-822a-76c69cae1744",
  status: "completed",
  content: [
    {
      type: "reasoning_text",
      text: 'We need answer user asks "Report which package manager this repository uses." Need investigate repo.',
    },
  ],
  summary: [],
  encrypted_content: "00863080-42ab-4186-9829-f841d1da6981-0",
};

describe("ModelTurn.reasoning", () => {
  it("从 reasoning items 聚合可见推理，且与 finalText 严格分离", () => {
    const response: ResponsesResultLike = {
      id: "response-1",
      output_text: "最终答案",
      output: [
        reasoningItem("先读文件，", "再写结论。"),
        { type: "message", content: [{ type: "output_text", text: "最终答案" }] },
        reasoningItem("复核一遍。"),
      ],
    };

    const turn = toModelTurn(response);

    expect(turn.finalText).toBe("最终答案");
    expect(turn.reasoning).toEqual(["先读文件，再写结论。", "复核一遍。"]);
    // 思维链文本绝不出现在 finalText 里。
    expect(turn.finalText).not.toContain("先读文件");
  });

  it("没有 reasoning item 时 reasoning 是 undefined（不是空数组）", () => {
    const response: ResponsesResultLike = {
      id: "response-2",
      output_text: "直接回答",
      output: [{ type: "message", content: [{ type: "output_text", text: "直接回答" }] }],
    };

    const turn = toModelTurn(response);

    expect(turn.reasoning).toBeUndefined();
    expect(Object.hasOwn(turn, "reasoning")).toBe(false);
  });

  it("只有空推理文本时同样视为缺失", () => {
    const response: ResponsesResultLike = {
      id: "response-3",
      output_text: "",
      output: [reasoningItem("")],
    };

    expect(toModelTurn(response).reasoning).toBeUndefined();
    expect(
      collectReasoning([{ type: "reasoning", content: [{ type: "reasoning_text" }] }]),
    ).toBeUndefined();
  });

  it("解析真实抓包的 reasoning item（正文在 text 字段，summary 为空）", () => {
    const turn = toModelTurn({
      id: "response-recorded",
      output_text: "",
      output: [recordedReasoningPayload],
    });

    expect(turn.reasoning).toEqual([
      'We need answer user asks "Report which package manager this repository uses." Need investigate repo.',
    ]);
  });

  it("网关把正文放在 reasoning_text 时仍然接受（防御性兼容）", () => {
    expect(
      collectReasoning([
        { type: "reasoning", content: [{ type: "reasoning_text", reasoning_text: "兼容分片。" }] },
      ]),
    ).toEqual(["兼容分片。"]);
  });

  it("summary_text 分片不算思维链正文，不会被误当成推理", () => {
    expect(
      collectReasoning([
        {
          type: "reasoning",
          content: [{ type: "summary_text", text: "这是摘要，不是正文。" }],
        },
      ]),
    ).toBeUndefined();
  });

  it("归一化层保留 reasoning item 的 content，最后进入 ModelTurn.reasoning", async () => {
    const payload = {
      id: "response-4",
      output: [
        {
          type: "reasoning",
          content: [{ type: "reasoning_text", text: "检查仓库结构。" }],
        },
        {
          type: "message",
          content: [{ type: "output_text", text: "仓库结构正常。" }],
        },
        {
          type: "function_call",
          call_id: "call-1",
          name: "read_file",
          arguments: '{"path":"package.json"}',
        },
      ],
      usage: { input_tokens: 12, output_tokens: 3 },
    };
    const client = createResponsesHttpClient({
      apiKey: "sk-test-not-a-real-key",
      fetchImpl: (async () =>
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    });

    const response = await client.responses.create({ model: "deepseek-v4-flash" });
    const turn = toModelTurn(response);

    expect(turn.finalText).toBe("仓库结构正常。");
    expect(turn.reasoning).toEqual(["检查仓库结构。"]);
    expect(turn.toolCalls).toEqual([
      { callId: "call-1", name: "read_file", argumentsJson: '{"path":"package.json"}' },
    ]);
    expect(turn.usage).toEqual({ inputTokens: 12, outputTokens: 3 });
  });
});

describe("journal 的 model_response.reasoning", () => {
  const tools: ToolDefinition[] = [
    { type: "function", name: "echo", description: "echo", parameters: {}, strict: true },
  ];

  it("把 start / continue 两轮的推理都写进 JSONL 与可读行", async () => {
    const directory = await makeTempDir("journal-reasoning-");
    try {
      const logPath = join(directory, "journal.jsonl");
      const { lines, write } = collector();
      const journal = createJournal({ verbose: true, logPath, truncate: true, write });
      const inner: ModelDriver = {
        async start() {
          return {
            responseId: "response-1",
            finalText: "",
            reasoning: ["先看一眼目录。", "然后调用工具。"],
            toolCalls: [{ callId: "call-1", name: "echo", argumentsJson: '{"value":"hi"}' }],
          };
        },
        async continue() {
          return {
            responseId: "response-2",
            finalText: "完成",
            reasoning: ["结果符合预期。"],
            toolCalls: [],
          };
        },
      };
      const driver = createJournalModelDriver(inner, journal);

      await driver.start({
        request: { instructions: "SYS", input: [{ role: "user", content: "任务" }] },
        tools,
      });
      await driver.continue({
        previousResponseId: "response-1",
        instructions: "SYS",
        continuationContext: [],
        outputs: [{ type: "function_call_output", call_id: "call-1", output: "ok" }],
        tools,
      });
      journal.close();

      const records = (await readFile(logPath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const responses = records.filter((record) => record["kind"] === "model_response");

      expect(responses).toHaveLength(2);
      expect(responses[0]?.["reasoning"]).toEqual(["先看一眼目录。", "然后调用工具。"]);
      expect(responses[1]?.["reasoning"]).toEqual(["结果符合预期。"]);
      expect(lines.join("\n")).toContain("[model] reasoning[0]: 先看一眼目录。");
      expect(lines.join("\n")).toContain("[model] reasoning[1]: 然后调用工具。");
    } finally {
      await removeTempDir(directory);
    }
  });

  it("模型没给推理时 JSONL 里没有 reasoning 字段", async () => {
    const directory = await makeTempDir("journal-no-reasoning-");
    try {
      const logPath = join(directory, "journal.jsonl");
      const { lines, write } = collector();
      const journal = createJournal({ verbose: true, logPath, truncate: true, write });
      const inner: ModelDriver = {
        async start() {
          return { responseId: "response-1", finalText: "done", toolCalls: [] };
        },
        async continue() {
          return { responseId: "response-2", finalText: "done", toolCalls: [] };
        },
      };

      await createJournalModelDriver(inner, journal).start({
        request: { instructions: "SYS", input: [] },
        tools,
      });
      journal.close();

      const records = (await readFile(logPath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const record = records.find((candidate) => candidate["kind"] === "model_response");
      expect(record).toBeDefined();
      expect(record === undefined ? true : Object.hasOwn(record, "reasoning")).toBe(false);
      expect(lines.join("\n")).not.toContain("[model] reasoning[");
    } finally {
      await removeTempDir(directory);
    }
  });

  it("推理文本同样遵守单条 20000 字符的截断规则", async () => {
    const block = "r".repeat(30_000);
    const { lines, write } = collector();
    const journal = createJournal({ verbose: true, truncate: true, write });

    journal.modelResponse({
      step: 1,
      phase: "start",
      responseId: "response-1",
      finalText: "",
      reasoning: [block],
      toolCalls: [],
      durationMs: 1,
    });
    journal.close();

    const joined = lines.join("\n");
    expect(joined).toContain(`…truncated(原长度 ${block.length})`);
    expect(joined).not.toContain(block);
    expect(joined).toContain("r".repeat(19_000));
    expect(joined.length).toBeLessThan(DEFAULT_JOURNAL_MAX_CHARACTERS + 2_000);
  });
});
