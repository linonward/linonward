import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createJournal,
  createJournalModelDriver,
  createJournalToolHook,
} from "../../../packages/agent-from-scratch-fixture/src/cli-journal.js";
import type { ModelDriver } from "../../../packages/agent-from-scratch-fixture/src/model.js";
import { RunHub, type StoredEntry } from "../server/bus.js";
import { startJournalTailer } from "../server/journal-tail.js";
import { parseJournalRecord } from "../src/lib/journal.js";

/**
 * 离线打通"journal → JSONL 增量读取 → 进程内总线"这条真实链路。
 *
 * 这里不发任何模型请求：模型驱动是注入的替身，但它经过**真实的**
 * `createJournalModelDriver` 装饰器，因此拿到的是和线上完全一样的记录形状。
 */
describe("journal 流水线（离线替身模型）", () => {
  it("模型记录（含 reasoning）与工具记录都会实时进入总线", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-console-pipeline-"));
    try {
      const logPath = join(directory, "journal.jsonl");
      const hub = new RunHub();
      const channel = hub.create("run-1");
      const journal = createJournal({
        verbose: true,
        logPath,
        truncate: true,
        write: (line) => {
          channel.push({ kind: "log_line", text: line });
        },
      });
      const tailer = startJournalTailer({
        path: logPath,
        intervalMs: 5,
        onRecord: (record) => {
          channel.push(record);
        },
      });

      const inner: ModelDriver = {
        async start() {
          return {
            responseId: "response-1",
            finalText: "",
            reasoning: ["先读文件。"],
            usage: { inputTokens: 10, outputTokens: 2 },
            toolCalls: [{ callId: "call-1", name: "read_file", argumentsJson: '{"path":"a"}' }],
          };
        },
        async continue() {
          return { responseId: "response-2", finalText: "完成", toolCalls: [] };
        },
      };
      const driver = createJournalModelDriver(inner, journal, { modelId: "deepseek-v4-flash" });

      journal.runMeta({
        command: "run",
        task: "读取文件",
        cwd: "/workspace",
        budgets: { maxSteps: 4, maxToolCalls: 8 },
        allowedArgv: [],
        requireSandbox: false,
        modelId: "deepseek-v4-flash",
      });
      await driver.start({
        request: { instructions: "SYS", input: [{ role: "user", content: "读取文件" }] },
        tools: [],
      });

      // 工具钩子是 Loop 侧的真实入口：先记调用，再记结果。
      createJournalToolHook(journal)({
        call: { callId: "call-1", name: "read_file", argumentsJson: '{"path":"a"}' },
        result: {
          type: "observation",
          callId: "call-1",
          output: '{"ok":true}',
          ok: true,
          effect: "read",
        },
        durationMs: 3,
        policy: { type: "allow", scope: "read:read_file" },
      });
      tailer.flush();
      tailer.stop();
      journal.close();

      const entries: StoredEntry[] = [];
      channel.subscribe(0, {
        onEntry: (entry) => entries.push(entry),
        onDone: () => undefined,
      });
      const records = entries
        .filter((entry) => entry.record["kind"] !== "log_line")
        .map((entry) => entry.record);

      const modelResponse = records.find((record) => record["kind"] === "model_response");
      expect(modelResponse?.["reasoning"]).toEqual(["先读文件。"]);
      expect(modelResponse?.["finalText"]).toBe("");
      expect(records.map((record) => record["kind"])).toEqual([
        "run_started",
        "model_request",
        "model_response",
        "usage",
        "tool_call",
        "tool_result",
      ]);
      expect(records.at(-1)?.["ok"]).toBe(true);

      // 每一条总线记录都必须是可解析的 journal JSON（SSE 的 data 直接用它）。
      for (const entry of entries) {
        expect(parseJournalRecord(JSON.stringify(entry.record))).toBeDefined();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
