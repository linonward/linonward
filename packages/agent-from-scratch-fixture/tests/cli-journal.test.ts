import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createJournal,
  createJournalModelDriver,
  createJournalToolHook,
  DEFAULT_JOURNAL_MAX_CHARACTERS,
  type JournalModelUsage,
  type JournalRunUsage,
} from "../src/cli-journal.js";
import type { ToolExecutionResult } from "../src/execute-tool.js";
import type { ModelDriver, ToolCall, ToolDefinition } from "../src/model.js";
import type { PriceTable } from "../src/pricing.js";
import { makeTempDir, removeTempDir } from "./support.js";

function collector(): { lines: string[]; write: (line: string) => void } {
  const lines: string[] = [];
  return { lines, write: (line) => void lines.push(line) };
}

describe("createJournal", () => {
  it("verbose 关闭时是 no-op：不写 stderr、不创建文件", async () => {
    const directory = await makeTempDir("journal-noop-");
    try {
      const logPath = join(directory, "journal.jsonl");
      const { lines, write } = collector();
      const journal = createJournal({ verbose: false, logPath, truncate: true, write });

      expect(journal.active).toBe(false);
      journal.runMeta({
        command: "run",
        task: "任务",
        cwd: "/workspace",
        budgets: { maxSteps: 16, maxToolCalls: 32 },
        allowedArgv: [],
        requireSandbox: false,
      });
      journal.modelRequest({
        step: 1,
        phase: "start",
        instructions: "SYS",
        input: [{ role: "user", content: "任务" }],
        toolNames: [],
      });
      journal.close();
      journal.close();

      expect(lines).toEqual([]);
      await expect(readFile(logPath, "utf8")).rejects.toThrow();
    } finally {
      await removeTempDir(directory);
    }
  });

  it("默认把单条内容截断到 20000 字符并标注原长度", () => {
    const blob = "z".repeat(30_000);
    const output = JSON.stringify({ blob });
    const { lines, write } = collector();
    const journal = createJournal({ verbose: true, truncate: true, write });

    journal.toolResult({
      callId: "call-1",
      name: "huge",
      durationMs: 3,
      ok: true,
      effect: "read",
      output,
    });
    journal.close();

    const joined = lines.join("\n");
    expect(joined).toContain(`…truncated(原长度 ${output.length})`);
    expect(joined).not.toContain(blob);
    // 前缀被保留（`{"blob":"` 占掉少量字符，因此断言一个安全的前缀长度）。
    expect(joined).toContain("z".repeat(19_000));
    expect(joined.length).toBeLessThan(DEFAULT_JOURNAL_MAX_CHARACTERS + 2_000);
  });

  it("--no-truncate 写完整内容，并在第一行给出截断关闭警告", () => {
    const blob = "z".repeat(30_000);
    const output = JSON.stringify({ blob });
    const { lines, write } = collector();
    const journal = createJournal({ verbose: true, truncate: false, write });

    journal.toolResult({
      callId: "call-1",
      name: "huge",
      durationMs: 3,
      ok: true,
      effect: "read",
      output,
    });
    journal.close();

    expect(lines[0]).toContain("[journal] warning: truncation disabled");
    expect(lines.join("\n")).toContain(blob);
  });

  it("把同一条日志以 JSONL 追加写入文件（每行一个 JSON 对象）", async () => {
    const directory = await makeTempDir("journal-jsonl-");
    try {
      const logPath = join(directory, "journal.jsonl");
      const { lines, write } = collector();
      const journal = createJournal({ verbose: true, logPath, truncate: true, write });

      journal.runMeta({
        command: "run",
        task: "读取 package.json",
        cwd: "/workspace",
        budgets: { maxSteps: 4, maxToolCalls: 8 },
        allowedArgv: [["node", "--version"]],
        requireSandbox: true,
        modelId: "deepseek-v4-flash",
      });
      journal.modelRequest({
        step: 1,
        phase: "start",
        instructions: "You are a repository coding agent.",
        input: [{ role: "user", content: "读取 package.json" }],
        toolNames: ["echo"],
      });
      journal.modelResponse({
        step: 1,
        phase: "start",
        responseId: "response-1",
        finalText: "",
        toolCalls: [{ callId: "call-1", name: "echo", argumentsJson: '{"value":"hi"}' }],
        durationMs: 2,
      });
      journal.toolCall({
        callId: "call-1",
        name: "echo",
        argumentsJson: '{"value":"hi"}',
        durationMs: 1,
      });
      journal.toolResult({
        callId: "call-1",
        name: "echo",
        durationMs: 1,
        ok: true,
        effect: "read",
        output: '{"ok":true,"data":{"echoed":"hi"}}',
        policy: { type: "allow", scope: "read:echo" },
      });
      journal.close();

      const records = (await readFile(logPath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);

      expect(records.map((record) => record["kind"])).toEqual([
        "run_started",
        "model_request",
        "model_response",
        "tool_call",
        "tool_result",
      ]);
      expect(records[0]?.["budgets"]).toEqual({ maxSteps: 4, maxToolCalls: 8 });
      expect(records[0]?.["modelId"]).toBe("deepseek-v4-flash");
      expect(records[4]?.["policy"]).toEqual({ type: "allow", scope: "read:echo" });
      // 双写：stderr 上同样有可读日志。
      expect(lines.join("\n")).toContain("[model] request step=1 phase=start");
      expect(lines.join("\n")).toContain("[tool] result callId=call-1 name=echo");
    } finally {
      await removeTempDir(directory);
    }
  });
});

describe("createJournalModelDriver", () => {
  const tools: ToolDefinition[] = [
    { type: "function", name: "echo", description: "echo", parameters: {}, strict: true },
  ];

  it("按 start / continue 记录真实请求与响应", async () => {
    const { lines, write } = collector();
    const journal = createJournal({ verbose: true, truncate: true, write });
    const inner: ModelDriver = {
      async start() {
        return { responseId: "response-1", finalText: "hello", toolCalls: [] };
      },
      async continue() {
        return {
          responseId: "response-2",
          finalText: "done",
          toolCalls: [{ callId: "call-2", name: "echo", argumentsJson: '{"value":"x"}' }],
        };
      },
    };
    const driver = createJournalModelDriver(inner, journal);

    await driver.start({
      request: { instructions: "SYSTEM PROMPT", input: [{ role: "user", content: "任务" }] },
      tools,
    });
    await driver.continue({
      previousResponseId: "response-1",
      instructions: "SYSTEM PROMPT",
      continuationContext: [{ role: "user", content: "更多" }],
      outputs: [{ type: "function_call_output", call_id: "call-1", output: "out-1" }],
      tools,
    });
    journal.close();

    const joined = lines.join("\n");
    expect(joined).toContain("[model] request step=1 phase=start");
    expect(joined).toContain("[model] instructions: SYSTEM PROMPT");
    expect(joined).toContain("[model] input[0] role=user: 任务");
    expect(joined).toContain("[model] tools: echo");
    expect(joined).toContain("[model] response step=1 phase=start");
    expect(joined).toContain("[model] finalText: hello");
    expect(joined).toContain("[model] request step=2 phase=continue");
    expect(joined).toContain("previousResponseId=response-1");
    expect(joined).toContain("[model] output[0] callId=call-1: out-1");
    expect(joined).toContain(
      '[model] toolCall callId=call-2 name=echo argumentsJson={"value":"x"}',
    );
  });

  it("每次模型调用记一行 [usage]（token 未知即 unknown，成本来自注入的价目表）", async () => {
    const table: PriceTable = {
      asOf: "2024-01-01",
      source: "https://example.test/pricing",
      models: {
        "test-model": {
          inputPerMillionUsd: 1_000,
          cachedInputPerMillionUsd: 100,
          outputPerMillionUsd: 2_000,
          asOf: "2024-01-01",
        },
      },
    };
    const { lines, write } = collector();
    const journal = createJournal({ verbose: true, truncate: true, write });
    // 第一次调用带 usage，第二次不带：第二次必须显示 unknown，而不是 0。
    const inner: ModelDriver = {
      async start() {
        return {
          responseId: "response-1",
          finalText: "",
          toolCalls: [],
          usage: { inputTokens: 1_000, outputTokens: 500, cachedInputTokens: 400 },
        };
      },
      async continue() {
        return { responseId: "response-2", finalText: "done", toolCalls: [] };
      },
    };
    const driver = createJournalModelDriver(inner, journal, {
      modelId: "test-model",
      table,
    });

    await driver.start({
      request: { instructions: "SYS", input: [{ role: "user", content: "任务" }] },
      tools,
    });
    await driver.continue({
      previousResponseId: "response-1",
      instructions: "SYS",
      continuationContext: [],
      outputs: [],
      tools,
    });
    journal.close();

    const usageLines = lines.filter((line) => line.startsWith("[usage] "));
    expect(usageLines).toHaveLength(2);
    // 600k/1M * $1000 + 400k/1M * $100 + 0.5M * $2000 = 0.6 + 0.04 + 1 = $1.64
    expect(usageLines[0]).toMatch(
      /^\[usage\] step=1 phase=start in=1000 out=500 cached=400 durationMs=\d+ model=test-model cost=\$1\.640000$/,
    );
    expect(usageLines[1]).toMatch(
      /^\[usage\] step=2 phase=continue in=unknown out=unknown cached=unknown durationMs=\d+ model=test-model cost=unknown$/,
    );
  });

  it("没有模型 id 时 [usage] 行显示 model=unknown / cost=unknown", async () => {
    const { lines, write } = collector();
    const journal = createJournal({ verbose: true, truncate: true, write });
    const driver = createJournalModelDriver(
      {
        async start() {
          return {
            responseId: "response-1",
            finalText: "",
            toolCalls: [],
            usage: { inputTokens: 10, outputTokens: 5 },
          };
        },
        async continue() {
          throw new Error("unused");
        },
      },
      journal,
    );

    await driver.start({
      request: { instructions: "SYS", input: [{ role: "user", content: "任务" }] },
      tools,
    });
    journal.close();

    expect(lines.join("\n")).toContain("model=unknown cost=unknown");
  });
});

describe("journal usage records", () => {
  it("运行结束写 [usage] run: 行与 kind=usage JSONL（含价目表 asOf / source）", async () => {
    const directory = await makeTempDir("journal-usage-");
    try {
      const logPath = join(directory, "journal.jsonl");
      const { lines, write } = collector();
      const journal = createJournal({ verbose: true, logPath, truncate: true, write });
      const entry: JournalRunUsage = {
        scope: "run",
        modelCalls: 4,
        toolCalls: 7,
        inputTokens: 1234,
        outputTokens: 256,
        cachedInputTokens: 1024,
        wallMs: 3210,
        costUsd: 0.000123,
        prices: { asOf: "2024-01-01", source: "https://example.test/pricing" },
        costBasis: "cache hits billed separately",
      };

      journal.usage(entry);
      journal.usage({ ...entry, costUsd: undefined, prices: undefined, costBasis: undefined });
      journal.close();

      expect(lines[0]).toBe(
        "[usage] run: modelCalls=4 toolCalls=7 in=1234 out=256 cached=1024 wallMs=3210 cost=$0.000123 (prices asOf=2024-01-01, source=https://example.test/pricing; cache hits billed separately)",
      );
      // 成本未知时明确写 unknown，而不是 $0.000000。
      expect(lines[1]).toBe(
        "[usage] run: modelCalls=4 toolCalls=7 in=1234 out=256 cached=1024 wallMs=3210 cost=unknown",
      );

      const records = (await readFile(logPath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records.map((record) => record["kind"])).toEqual(["usage", "usage"]);
      expect(records[0]).toMatchObject({
        kind: "usage",
        scope: "run",
        modelCalls: 4,
        toolCalls: 7,
        inputTokens: 1234,
        outputTokens: 256,
        cachedInputTokens: 1024,
        wallMs: 3210,
        costUsd: 0.000123,
        prices: { asOf: "2024-01-01", source: "https://example.test/pricing" },
      });
      // 未知字段不写进 JSONL（缺失就是缺失）。
      expect(records[1]).not.toHaveProperty("costUsd");
      expect(records[1]).not.toHaveProperty("prices");
    } finally {
      await removeTempDir(directory);
    }
  });

  it("单次调用的 usage 也写 JSONL，未知字段缺省", async () => {
    const directory = await makeTempDir("journal-usage-model-");
    try {
      const logPath = join(directory, "journal.jsonl");
      const journal = createJournal({ verbose: true, logPath, truncate: true, write: () => {} });
      const entry: JournalModelUsage = {
        scope: "model",
        step: 2,
        phase: "continue",
        modelId: "test-model",
        inputTokens: 10,
        durationMs: 5,
        costUsd: 0,
      };

      journal.usage(entry);
      journal.close();

      const records = (await readFile(logPath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records[0]).toMatchObject({
        kind: "usage",
        scope: "model",
        step: 2,
        phase: "continue",
        model: "test-model",
        inputTokens: 10,
        costUsd: 0,
      });
      expect(records[0]).not.toHaveProperty("outputTokens");
      expect(records[0]).not.toHaveProperty("cachedInputTokens");
    } finally {
      await removeTempDir(directory);
    }
  });
});

describe("journal plan_revised records", () => {
  it("只写 JSONL，带上 reason + 计划差异 + 触发证据", async () => {
    const directory = await makeTempDir("journal-plan-");
    try {
      const logPath = join(directory, "journal.jsonl");
      const { lines, write } = collector();
      const journal = createJournal({ verbose: true, logPath, truncate: true, write });

      journal.planRevised({
        version: 2,
        reason: "repeated_tool_failure",
        detail: {
          type: "plan_revised",
          reason: "repeated_tool_failure",
          addedSteps: ["step-2"],
          removedSteps: [],
          renamedSteps: ["step-1"],
          addedStepsOmitted: 0,
          removedStepsOmitted: 0,
          renamedStepsOmitted: 0,
          dependencyChanges: 1,
          recentFailures: [{ name: "boom", errorCode: "tool_error" }],
          recentFailuresOmitted: 0,
        },
      });
      journal.close();

      const records = (await readFile(logPath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(records[0]?.["kind"]).toBe("plan_revised");
      expect(records[0]?.["version"]).toBe(2);
      expect(records[0]?.["reason"]).toBe("repeated_tool_failure");
      expect(records[0]?.["detail"]).toMatchObject({
        addedSteps: ["step-2"],
        renamedSteps: ["step-1"],
        dependencyChanges: 1,
        recentFailures: [{ name: "boom", errorCode: "tool_error" }],
      });
      // 可读行由 verbose 的 `[event] plan_revised ...` 负责：这里不重复打印。
      expect(lines.filter((line) => line.startsWith("[plan]"))).toHaveLength(0);
    } finally {
      await removeTempDir(directory);
    }
  });
});

describe("createJournalToolHook", () => {
  it("记录调用参数与 observation 全文（含 policy 决定）", () => {
    const { lines, write } = collector();
    const journal = createJournal({ verbose: true, truncate: true, write });
    const hook = createJournalToolHook(journal);

    const call: ToolCall = {
      callId: "call-1",
      name: "echo",
      argumentsJson: '{"value":"hi"}',
    };
    const result: ToolExecutionResult = {
      type: "observation",
      callId: "call-1",
      output: '{"ok":true,"data":{"echoed":"hi"}}',
      ok: true,
      effect: "read",
      policy: { type: "allow", scope: "read:echo" },
    };

    hook({ call, result, durationMs: 7, policy: result.policy });
    journal.close();

    const joined = lines.join("\n");
    expect(joined).toContain("[tool] call callId=call-1 name=echo");
    expect(joined).toContain('argsJson={"value":"hi"}');
    expect(joined).toContain("[tool] result callId=call-1 name=echo");
    expect(joined).toContain("durationMs=7");
    expect(joined).toContain("ok=true effect=read");
    expect(joined).toContain('[tool] output: {"ok":true,"data":{"echoed":"hi"}}');
    expect(joined).toContain('[tool] policy: {"type":"allow","scope":"read:echo"}');
  });

  it("waiting 结果记录为 status=waiting 而不是伪造 observation", () => {
    const { lines, write } = collector();
    const journal = createJournal({ verbose: true, truncate: true, write });
    const hook = createJournalToolHook(journal);

    const call: ToolCall = { callId: "call-9", name: "run_command", argumentsJson: "{}" };
    hook({
      call,
      result: { type: "waiting", requestId: "request-1", reason: "approval_required" },
      durationMs: 0,
    });
    journal.close();

    const joined = lines.join("\n");
    expect(joined).toContain("status=waiting requestId=request-1 reason=approval_required");
    expect(joined).not.toContain("[tool] output:");
  });

  it("失败结果写 error=<code> 与截断后的可读原因（JSONL 同样有 error / reason）", async () => {
    const directory = await makeTempDir("journal-tool-error-");
    try {
      const logPath = join(directory, "journal.jsonl");
      const { lines, write } = collector();
      const journal = createJournal({ verbose: true, logPath, truncate: true, write });
      const hook = createJournalToolHook(journal);
      const longMessage = "x".repeat(30_000);

      const call: ToolCall = { callId: "call-2", name: "boom", argumentsJson: "{}" };
      hook({
        call,
        result: {
          type: "observation",
          callId: "call-2",
          output: JSON.stringify({ ok: false, error: "tool_error", message: longMessage }),
          ok: false,
          effect: "read",
          errorCode: "tool_error",
        },
        durationMs: 3,
      });
      journal.close();

      const joined = lines.join("\n");
      expect(joined).toContain("[tool] result callId=call-2 name=boom");
      expect(joined).toContain("ok=false effect=read error=tool_error reason=");
      // 原因同样走截断：整行不会因为 observation message 而爆掉。
      expect(joined).not.toContain(longMessage);

      const records = (await readFile(logPath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const result = records.find((record) => record["kind"] === "tool_result");
      expect(result?.["ok"]).toBe(false);
      expect(result?.["error"]).toBe("tool_error");
      expect(String(result?.["reason"])).toContain("…truncated");
    } finally {
      await removeTempDir(directory);
    }
  });
});
