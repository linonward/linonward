import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { type RunChannel, RunHub } from "../server/bus.js";
import { createConsoleRunner, RunnerError, type StartRunInput } from "../server/runner.js";

const FAKE_KEY = "sk-offline-test-not-a-real-key";

function startInput(overrides: Partial<StartRunInput> = {}): StartRunInput {
  return {
    task: "读取 package.json",
    cwd: tmpdir(),
    allowedArgv: [],
    maxSteps: 2,
    maxToolCalls: 2,
    approveAllowed: false,
    requireSandbox: false,
    repeatGuard: true,
    ...overrides,
  };
}

async function waitForDone(channel: RunChannel, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!channel.done) {
    if (Date.now() > deadline) throw new Error("运行没有在超时内结束");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function collected(channel: RunChannel): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  channel.subscribe(0, {
    onEntry: (entry) => records.push(entry.record),
    onDone: () => undefined,
  });
  return records;
}

/**
 * 真实运行器的装配 + 收尾链路，**完全离线**：
 * 密钥是假的、`DEEPSEEK_BASE_URL` 指向一个必然连不上的本地端口，因此不会产生任何
 * 真实模型请求；但 `createContext` / `runAgentLoop` / journal 双写 / 事件总线 /
 * `settle` 都是线上那一套。
 */
describe("createConsoleRunner（离线，假密钥 + 不可达 baseUrl）", () => {
  it("缺密钥时 start 直接抛 400，且不会启动运行", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-console-runner-"));
    try {
      const runner = createConsoleRunner({
        env: {},
        hub: new RunHub(),
        storeRoot: directory,
      });
      await expect(runner.start(startInput())).rejects.toBeInstanceOf(RunnerError);
      await expect(runner.start(startInput())).rejects.toThrow("DEEPSEEK_API_KEY");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("运行失败也会走完 journal → 总线，并把 run_stopped 推给订阅者（密钥不外泄）", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-console-runner-"));
    try {
      const hub = new RunHub();
      const runner = createConsoleRunner({
        env: {
          DEEPSEEK_API_KEY: FAKE_KEY,
          DEEPSEEK_BASE_URL: "http://127.0.0.1:9/v1",
        },
        hub,
        storeRoot: directory,
      });

      const { runId } = await runner.start(startInput());
      const channel = hub.get(runId);
      expect(channel).toBeDefined();
      if (channel === undefined) return;

      await waitForDone(channel);
      const records = collected(channel);
      const kinds = records.map((record) => record["kind"]);

      // journal 的 run_started 一定先到（可读日志行可能夹在中间）；结束一定以 run_stopped 收尾。
      const structured = kinds.filter((kind) => kind !== "log_line");
      expect(structured[0]).toBe("run_started");
      expect(kinds.at(-1)).toBe("run_stopped");
      expect(records.at(-1)?.["status"]).toBe("failed");
      // 可读日志行也进了总线（原始事件区）。
      expect(kinds).toContain("log_line");

      // 任何推给浏览器的内容都不包含密钥。
      expect(JSON.stringify(records)).not.toContain(FAKE_KEY);

      // journal 双写：结构化记录落在运行目录的 JSONL 里。
      const journal = await readFile(join(directory, runId, "journal.jsonl"), "utf8");
      expect(journal).toContain('"kind":"run_started"');
      expect(journal).not.toContain(FAKE_KEY);

      // 运行失败太早时没有 checkpoint：快照返回 undefined 而不是崩掉。
      await expect(runner.snapshot(runId)).resolves.toBeUndefined();
      await expect(runner.snapshot("does-not-exist")).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("对未知运行 answer 返回 404 语义的 RunnerError", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agent-console-runner-"));
    try {
      const runner = createConsoleRunner({
        env: { DEEPSEEK_API_KEY: FAKE_KEY },
        hub: new RunHub(),
        storeRoot: directory,
      });

      await expect(
        runner.answer("missing-run", { requestId: "req-1", text: "同意" }),
      ).rejects.toMatchObject({ status: 404 });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
