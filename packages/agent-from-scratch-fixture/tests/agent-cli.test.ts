import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  AGENT_DEFAULT_MAX_STEPS,
  AGENT_DEFAULT_MAX_TOOL_CALLS,
  AGENT_USAGE,
  createDeepSeekAgentCli,
  parseAgentArgs,
} from "../src/agent-cli.js";
import {
  createVerboseObserver,
  MAX_VERBOSE_DETAIL_CHARACTERS,
  MAX_VERBOSE_REASON_CHARACTERS,
  MAX_VERBOSE_TOOL_OBSERVATIONS,
} from "../src/cli-verbose.js";
import {
  FakeModelDriver,
  textTurn,
  turnWithTools,
  userInputTurn,
  withUsage,
} from "../src/fake-model.js";
import type { AgentCliOptions } from "../src/index.js";
import { createAgentCliRuntime, EXIT_CODES, runCli } from "../src/index.js";
import type { ModelUsage, NormalizedModelResponse } from "../src/model.js";
import {
  createStatelessResponsesDriver,
  type StatelessResponsesClient,
} from "../src/responses-stateless-driver.js";
import { InMemoryRunStore } from "../src/run-store.js";
import { PreApprovingLedger } from "../src/run-task.js";
import { createInitialState } from "../src/state.js";
import { defineTool } from "../src/tool.js";
import { runCommandTool } from "../src/tools/run-command.js";
import {
  CompletingPlanner,
  createRegistry,
  echoTool,
  failingTool,
  hugeTool,
  makeDraft,
  makeTempDir,
  notCompleted,
  removeTempDir,
  ScriptedPlanner,
} from "./support.js";

/** 假的 Responses 客户端：按脚本返回**归一化**响应（含 `usage`）。 */
function scriptedResponsesClient(replies: NormalizedModelResponse[]) {
  type ClientBody = Parameters<StatelessResponsesClient["responses"]["create"]>[0];
  const bodies: ClientBody[] = [];
  return {
    bodies,
    client: {
      responses: {
        async create(body: ClientBody) {
          bodies.push(body);
          const next = replies.shift();
          if (!next) throw new Error("scripted responses ran out");
          return next;
        },
      },
    },
  };
}

/** 测试自带的价目表：不依赖真实价格，数字都是好算的整十整百。 */
const TEST_PRICE_TABLE = {
  asOf: "2024-01-01",
  source: "https://example.test/pricing",
  models: {
    "deepseek-v4-flash": {
      inputPerMillionUsd: 100,
      cachedInputPerMillionUsd: 10,
      outputPerMillionUsd: 200,
      asOf: "2024-01-01",
    },
  },
};

/** 运行摘要写在 stderr 最后：这里逆序找出带 runId 的那一行。 */
function runIdFromStderr(stderr: string[]): string {
  for (let index = stderr.length - 1; index >= 0; index -= 1) {
    const match = /"runId":"([^"]+)"/.exec(stderr[index] ?? "");
    if (match?.[1] !== undefined) return match[1];
  }
  throw new Error("stderr 里没有 runId");
}

function pendingInputTurn() {
  return userInputTurn({
    id: "request-1",
    kind: "clarification",
    question: "用哪个包管理器？",
    reason: "需要用户确认",
    createdAt: new Date().toISOString(),
  });
}

describe("parseAgentArgs", () => {
  it("parses run / resume / answer and fills in the defaults", () => {
    const run = parseAgentArgs(["run", "读取 package.json"]);
    expect(run.command).toEqual({ command: "run", task: "读取 package.json" });
    expect(run.config).toEqual({
      cwd: process.cwd(),
      allowedArgv: [],
      requireSandbox: false,
      autoApproveAllowedCommands: false,
      maxSteps: AGENT_DEFAULT_MAX_STEPS,
      maxToolCalls: AGENT_DEFAULT_MAX_TOOL_CALLS,
      verbose: false,
      logPath: undefined,
      noTruncate: false,
      repeatGuard: true,
    });

    expect(parseAgentArgs(["resume", "run-1"]).command).toEqual({
      command: "resume",
      runId: "run-1",
    });
    expect(parseAgentArgs(["answer", "run-1", "request-1", "用 pnpm"]).command).toEqual({
      command: "answer",
      runId: "run-1",
      requestId: "request-1",
      content: "用 pnpm",
    });
  });

  it("解析钱与时间的硬上限", () => {
    const parsed = parseAgentArgs([
      "run",
      "任务",
      "--max-cost-usd",
      "0.5",
      "--max-wall-ms",
      "60000",
    ]);

    expect(parsed.config.maxCostUsd).toBe(0.5);
    expect(parsed.config.maxWallMs).toBe(60_000);
    expect(parseAgentArgs(["run", "任务"]).config.maxCostUsd).toBeUndefined();
    expect(parseAgentArgs(["run", "任务"]).config.maxWallMs).toBeUndefined();
  });

  it("非法的上限一律拒绝", () => {
    expect(() => parseAgentArgs(["run", "任务", "--max-cost-usd", "0"])).toThrow("max-cost-usd");
    expect(() => parseAgentArgs(["run", "任务", "--max-cost-usd", "-1"])).toThrow("max-cost-usd");
    expect(() => parseAgentArgs(["run", "任务", "--max-cost-usd", "abc"])).toThrow("max-cost-usd");
    expect(() => parseAgentArgs(["run", "任务", "--max-wall-ms", "0"])).toThrow("max-wall-ms");
  });

  it("collects flags and repeated --allow argv", () => {
    const { config } = parseAgentArgs([
      "run",
      "读取 package.json",
      "--cwd",
      "/tmp/demo",
      "--require-sandbox",
      "--approve-allowed",
      "--max-steps",
      "5",
      "--max-tool-calls",
      "7",
      "--allow",
      "node",
      "--version",
      "--allow",
      "pnpm",
      "test",
    ]);

    expect(config).toEqual({
      cwd: "/tmp/demo",
      allowedArgv: [
        ["node", "--version"],
        ["pnpm", "test"],
      ],
      requireSandbox: true,
      autoApproveAllowedCommands: true,
      maxSteps: 5,
      maxToolCalls: 7,
      verbose: false,
      logPath: undefined,
      noTruncate: false,
      repeatGuard: true,
    });
  });

  it("--no-repeat-guard 关闭重复调用守卫，且可放在子命令前后", () => {
    expect(parseAgentArgs(["run", "任务"]).config.repeatGuard).toBe(true);

    const after = parseAgentArgs(["run", "任务", "--no-repeat-guard"]);
    expect(after.config.repeatGuard).toBe(false);
    expect(after.command).toEqual({ command: "run", task: "任务" });

    const before = parseAgentArgs(["--no-repeat-guard", "run", "任务"]);
    expect(before.config.repeatGuard).toBe(false);
    expect(before.command).toEqual({ command: "run", task: "任务" });
  });

  it("parses --verbose before or after the subcommand, and tolerates repeats", () => {
    expect(parseAgentArgs(["run", "任务"]).config.verbose).toBe(false);

    const after = parseAgentArgs(["run", "任务", "--verbose"]);
    expect(after.config.verbose).toBe(true);
    expect(after.command).toEqual({ command: "run", task: "任务" });

    const before = parseAgentArgs(["--verbose", "run", "任务"]);
    expect(before.config.verbose).toBe(true);
    expect(before.command).toEqual({ command: "run", task: "任务" });

    expect(parseAgentArgs(["resume", "run-1", "--verbose"]).config.verbose).toBe(true);
    expect(parseAgentArgs(["run", "任务", "--verbose", "--verbose"]).config.verbose).toBe(true);
  });

  it("parses --log <path> and --no-truncate without disturbing --allow", () => {
    const parsed = parseAgentArgs([
      "run",
      "任务",
      "--verbose",
      "--log",
      "logs/run.jsonl",
      "--no-truncate",
    ]);
    expect(parsed.config.verbose).toBe(true);
    expect(parsed.config.noTruncate).toBe(true);
    expect(parsed.config.logPath).toBe(resolve("logs/run.jsonl"));

    // `--allow` 的 argv 收集在 `--log` 处停止：路径不会被当成被允许的命令参数。
    const allowed = parseAgentArgs([
      "run",
      "任务",
      "--allow",
      "node",
      "--version",
      "--log",
      "run.jsonl",
    ]);
    expect(allowed.config.allowedArgv).toEqual([["node", "--version"]]);
    expect(allowed.config.logPath).toBe(resolve("run.jsonl"));

    expect(() => parseAgentArgs(["run", "任务", "--log"])).toThrow(AGENT_USAGE);
    expect(() => parseAgentArgs(["run", "任务", "--log", "--verbose"])).toThrow(AGENT_USAGE);
  });

  it("rejects unknown flags and malformed values with the agent usage", () => {
    const invalid: string[][] = [
      ["run", "任务", "--nope"],
      ["run", "任务", "--max-steps", "abc"],
      ["run", "任务", "--max-tool-calls", "0"],
      ["run", "任务", "--cwd"],
      ["run", "任务", "--allow"],
      ["run"],
      ["resume"],
      ["answer", "run-1", "request-1"],
    ];

    for (const argv of invalid) {
      expect(() => parseAgentArgs(argv), argv.join(" ")).toThrow(AGENT_USAGE);
    }
  });
});

describe("createDeepSeekAgentCli", () => {
  it("prints usage without needing a key when the arguments are invalid", async () => {
    const stderr: string[] = [];
    const cli = await createDeepSeekAgentCli({
      env: {},
      stdout: () => {},
      stderr: (text) => void stderr.push(text),
    });

    const code = await cli([]);

    expect(code).toBe(EXIT_CODES.usage);
    expect(stderr.at(-1)).toContain(AGENT_USAGE);
  });

  it("fails with .env.example guidance when DEEPSEEK_API_KEY is missing", async () => {
    const cli = await createDeepSeekAgentCli({
      env: {},
      stdout: () => {},
      stderr: () => {},
    });

    await expect(cli(["run", "读取 package.json"])).rejects.toThrow(/\.env\.example/);
  });

  it("runs the loop offline through injected deps and prints the final answer", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const cli = await createDeepSeekAgentCli({
      env: {},
      stdout: (text) => void stdout.push(text),
      stderr: (text) => void stderr.push(text),
      deps: {
        model: new FakeModelDriver([
          turnWithTools({ callId: "call-1", name: "echo", argumentsJson: '{"value":"hi"}' }),
          textTurn("项目使用 pnpm。"),
        ]),
        planner: new CompletingPlanner(makeDraft({}), ["criterion-1"]),
        tools: createRegistry(echoTool),
        store: new InMemoryRunStore(),
      },
    });

    const code = await cli(["run", "读取 package.json"]);

    expect(code).toBe(EXIT_CODES.completed);
    expect(stdout).toEqual(["项目使用 pnpm。"]);
    expect(stderr.at(-1)).toContain('"status":"completed"');
  });

  it("returns a non-zero code and a readable error for an unknown requestId", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const cli = await createDeepSeekAgentCli({
      env: {},
      stdout: (text) => void stdout.push(text),
      stderr: (text) => void stderr.push(text),
      deps: {
        model: new FakeModelDriver([pendingInputTurn()]),
        planner: new CompletingPlanner(makeDraft({}), ["criterion-1"]),
        tools: createRegistry(echoTool),
        store: new InMemoryRunStore(),
      },
    });

    const runCode = await cli(["run", "读取 package.json"]);
    expect(runCode).toBe(EXIT_CODES.waiting);
    const runId = runIdFromStderr(stderr);

    const answerCode = await cli(["answer", runId, "unknown-request", "用 pnpm"]);

    expect(answerCode).toBe(EXIT_CODES.failed);
    expect(stderr.at(-1)).toContain("unexpected_user_input");
  });

  /**
   * 审批必须跨"运行"与"回答"两次调用共享同一个批准账本：CLI 的 `agent answer` 是
   * 另一个进程、另一份内存账本，所以这里直接驱动 `runCli` 并复用一个账本，
   * 复现控制台（一个长驻进程、一个 per-run 账本）的情形。
   */
  it("approves a policy request and resumes the run (审批不是澄清)", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const approvals = new PreApprovingLedger();
    const runCommand = turnWithTools({
      callId: "call-1",
      name: "run_command",
      argumentsJson: '{"command":"node","args":["--version"]}',
    });
    const model = new FakeModelDriver([runCommand, runCommand, textTurn("node 版本已确认。")]);
    const store = new InMemoryRunStore();
    const base: AgentCliOptions = {
      cwd: process.cwd(),
      skillsDirectory: resolve(import.meta.dirname, "..", "skills"),
      store,
      model,
      planner: new CompletingPlanner(makeDraft({}), ["criterion-1"]),
      tools: createRegistry(runCommandTool),
      policy: {
        cwd: process.cwd(),
        realWorkspaceRoot: process.cwd(),
        allowedArgv: [["node", "--version"]],
        network: "disabled",
      },
      approvals,
      maxSteps: AGENT_DEFAULT_MAX_STEPS,
      maxToolCalls: AGENT_DEFAULT_MAX_TOOL_CALLS,
    };
    const dependencies = { createRuntime: createAgentCliRuntime(base) };
    const io = {
      stdout: (text: string) => void stdout.push(text),
      stderr: (text: string) => void stderr.push(text),
    };

    const runCode = await runCli(["run", "查看 node 版本"], dependencies, io, { verbose: true });
    expect(runCode).toBe(EXIT_CODES.waiting);
    const runId = runIdFromStderr(stderr);
    // 策略请求确实落在了这个账本里，且还是"待批准"。
    const pending = await approvals.pendingRequests(runId);
    expect(pending).toHaveLength(1);
    const requestId = pending[0]?.id ?? "";
    expect(requestId.length).toBeGreaterThan(0);

    const answerCode = await runCli(["answer", runId, requestId, "批准"], dependencies, io, {
      verbose: true,
    });

    expect(answerCode).toBe(EXIT_CODES.completed);
    expect(stdout.at(-1)).toBe("node 版本已确认。");
  });

  it("resumes a waiting run when the answer matches the pending request", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const cli = await createDeepSeekAgentCli({
      env: {},
      stdout: (text) => void stdout.push(text),
      stderr: (text) => void stderr.push(text),
      deps: {
        model: new FakeModelDriver([
          pendingInputTurn(),
          turnWithTools({ callId: "call-1", name: "echo", argumentsJson: '{"value":"hi"}' }),
          textTurn("项目使用 pnpm。"),
        ]),
        planner: new CompletingPlanner(makeDraft({}), ["criterion-1"]),
        tools: createRegistry(echoTool),
        store: new InMemoryRunStore(),
      },
    });

    const runCode = await cli(["run", "读取 package.json"]);
    expect(runCode).toBe(EXIT_CODES.waiting);
    const runId = runIdFromStderr(stderr);

    const answerCode = await cli(["answer", runId, "request-1", "用 pnpm"]);

    expect(answerCode).toBe(EXIT_CODES.completed);
    // 等待中的 `run` 也会写一次空 answer；最终答案追加在最后。
    expect(stdout.at(-1)).toBe("项目使用 pnpm。");
  });
});

describe("--verbose", () => {
  function offlineRun() {
    const stdout: string[] = [];
    const stderr: string[] = [];

    return createDeepSeekAgentCli({
      env: {},
      stdout: (text) => void stdout.push(text),
      stderr: (text) => void stderr.push(text),
      deps: {
        model: new FakeModelDriver([
          turnWithTools({ callId: "call-1", name: "echo", argumentsJson: '{"value":"hi"}' }),
          textTurn("项目使用 pnpm。"),
        ]),
        planner: new CompletingPlanner(makeDraft({}), ["criterion-1"]),
        tools: createRegistry(echoTool),
        store: new InMemoryRunStore(),
      },
    }).then((cli) => ({ cli, stdout, stderr }));
  }

  it("默认关闭时 stdout 仍只有最终答案，stderr 不带 verbose 前缀", async () => {
    const { cli, stdout, stderr } = await offlineRun();

    const code = await cli(["run", "读取 package.json"]);

    expect(code).toBe(EXIT_CODES.completed);
    expect(stdout).toEqual(["项目使用 pnpm。"]);
    for (const line of stderr) {
      expect(line.startsWith("[event] ")).toBe(false);
      expect(line.startsWith("[tool] ")).toBe(false);
      expect(line.startsWith("[summary] ")).toBe(false);
    }

    // 逐字节冻结默认输出：仍然是今天的 canonicalJson 事件行 + 一条摘要，没有新增任何行。
    expect(stderr).toHaveLength(7);
    expect(stderr[0]).toMatch(/^\{"runId":"[0-9a-f-]{36}","type":"run_started"\}$/);
    expect(stderr.slice(1, 6)).toEqual([
      '{"step":1,"type":"model_started"}',
      '{"step":1,"type":"model_completed"}',
      '{"step":2,"type":"model_started"}',
      '{"step":2,"type":"model_completed"}',
      '{"reason":"final_answer","type":"run_stopped"}',
    ]);
    expect(stderr[6]).toMatch(
      /^\{"changedFiles":\[\],"mutationRevision":0,"runId":"[0-9a-f-]{36}","status":"completed","stopReason":"final_answer"\}$/,
    );
  });

  it("打开后把事件行、工具观测摘要与详细汇总写到 stderr", async () => {
    const { cli, stdout, stderr } = await offlineRun();

    const code = await cli(["run", "读取 package.json", "--verbose"]);

    expect(code).toBe(EXIT_CODES.completed);
    // stdout 仍然只放最终答案，管道可用。
    expect(stdout).toEqual(["项目使用 pnpm。"]);

    const joined = stderr.join("\n");
    expect(joined).toContain("[event] run_started runId=");
    expect(joined).toContain("[event] model_started step=1");
    expect(joined).toContain("[event] model_completed step=1");
    expect(joined).toContain("[event] model_started step=2");
    expect(joined).toContain("[event] run_stopped reason=final_answer");
    expect(joined).toContain("[tool] echo callId=call-1 ok=true");
    expect(joined).toContain("stopReason=final_answer");
    expect(joined).toContain("budget modelSteps=2/16 toolCalls=1/32");
    expect(joined).toContain("changedFiles=");
    expect(joined).toContain("validations=0");
    expect(joined).toContain("trace=run_started");
  });

  it("完整日志包含模型的真实输入输出与完整工具链（带时间戳与耗时）", async () => {
    const { cli, stderr } = await offlineRun();

    const code = await cli(["run", "读取 package.json", "--verbose"]);

    expect(code).toBe(EXIT_CODES.completed);
    const joined = stderr.join("\n");

    // 模型请求：system prompt 全文 + 每条输入消息 + 工具名称列表。
    expect(joined).toContain("[model] request step=1 phase=start");
    expect(joined).toContain("You are a repository coding agent.");
    expect(joined).toContain("[model] input[0] role=user: 读取 package.json");
    expect(joined).toContain("[model] tools: echo");
    expect(joined).toContain("[run] task: 读取 package.json");

    // 模型响应：这一轮是 continue，含 responseId、finalText 与 toolCalls 参数。
    expect(joined).toContain("[model] request step=1 phase=start");
    expect(joined).toContain("[model] response step=2 phase=continue");
    expect(joined).toContain("responseId=response-text");
    expect(joined).toContain("[model] finalText: 项目使用 pnpm。");
    expect(joined).toContain(
      '[model] toolCall callId=call-1 name=echo argumentsJson={"value":"hi"}',
    );

    // 工具链：参数与 observation 全文。
    expect(joined).toContain("[tool] call callId=call-1 name=echo");
    expect(joined).toContain('argsJson={"value":"hi"}');
    expect(joined).toContain("[tool] result callId=call-1 name=echo");
    expect(joined).toContain("ok=true effect=read");
    expect(joined).toContain('[tool] output: {"ok":true,"data":{"echoed":"hi"}}');

    // 每一类都有 ISO 时间戳与耗时段。
    expect(joined).toMatch(
      /\[model\] request step=1 phase=start at=\d{4}-\d{2}-\d{2}T[\d:.]+Z durationMs=\d+/,
    );
    expect(joined).toMatch(
      /\[model\] response step=2 phase=continue at=\d{4}-\d{2}-\d{2}T[\d:.]+Z durationMs=\d+/,
    );
    expect(joined).toMatch(
      /\[tool\] call callId=call-1 name=echo at=\d{4}-\d{2}-\d{2}T[\d:.]+Z durationMs=\d+/,
    );
    expect(joined).toMatch(
      /\[tool\] result callId=call-1 name=echo at=\d{4}-\d{2}-\d{2}T[\d:.]+Z durationMs=\d+/,
    );
  });

  it("--log 把同一条完整日志追加成可解析的 JSONL", async () => {
    const directory = await makeTempDir("agent-journal-");
    try {
      const logPath = join(directory, "journal.jsonl");
      const { cli, stderr } = await offlineRun();

      const code = await cli(["run", "读取 package.json", "--verbose", "--log", logPath]);

      expect(code).toBe(EXIT_CODES.completed);
      const lines = (await readFile(logPath, "utf8")).trimEnd().split("\n");
      const records = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      const kinds = records.map((record) => record["kind"]);

      expect(kinds).toContain("run_started");
      expect(kinds).toContain("model_request");
      expect(kinds).toContain("model_response");
      expect(kinds).toContain("tool_call");
      expect(kinds).toContain("tool_result");

      const request = records.find((record) => record["kind"] === "model_request");
      expect(String(request?.["instructions"])).toContain("You are a repository coding agent.");
      expect(request?.["toolNames"]).toEqual(["echo"]);

      const toolCall = records.find((record) => record["kind"] === "tool_call");
      expect(toolCall?.["name"]).toBe("echo");
      expect(toolCall?.["argumentsJson"]).toBe('{"value":"hi"}');

      const toolResult = records.find((record) => record["kind"] === "tool_result");
      expect(toolResult?.["ok"]).toBe(true);
      expect(toolResult?.["output"]).toBe('{"ok":true,"data":{"echoed":"hi"}}');
      expect(toolResult?.["policy"]).toMatchObject({ type: "allow" });

      // 同一条日志同时出现在 stderr 与文件里。
      expect(stderr.join("\n")).toContain("[model] request step=1 phase=start");
    } finally {
      await removeTempDir(directory);
    }
  });

  it("--verbose 关闭时 --log 不创建 journal 文件、也不产生日志行", async () => {
    const directory = await makeTempDir("agent-journal-");
    try {
      const logPath = join(directory, "journal.jsonl");
      const { cli, stderr } = await offlineRun();

      const code = await cli(["run", "读取 package.json", "--log", logPath]);

      expect(code).toBe(EXIT_CODES.completed);
      await expect(readFile(logPath, "utf8")).rejects.toThrow();
      expect(stderr.join("\n")).not.toContain("[model] request");
      expect(stderr.join("\n")).not.toContain("[tool] call");
    } finally {
      await removeTempDir(directory);
    }
  });

  it("默认截断超长内容；--no-truncate 打印完整内容并在 stderr 顶部警告", async () => {
    const longTask = `读取 ${"y".repeat(30_000)}`;

    const truncatedRun = await offlineRun();
    expect(await truncatedRun.cli(["run", longTask, "--verbose"])).toBe(EXIT_CODES.completed);
    const truncated = truncatedRun.stderr.join("\n");
    expect(truncated).toContain("…truncated(原长度 30003)");
    expect(truncated).not.toContain(longTask);

    const fullRun = await offlineRun();
    expect(await fullRun.cli(["run", longTask, "--verbose", "--no-truncate"])).toBe(
      EXIT_CODES.completed,
    );
    expect(fullRun.stderr[0]).toContain("[journal] warning: truncation disabled");
    expect(fullRun.stderr.join("\n")).toContain(longTask);
  });

  /**
   * 计划反复修订却没有任何步骤完成：Loop 会以 `blocked_plan` 停止。
   * 这个 fixture 因此能在全离线条件下产生真实的 `plan_blocked` 事件。
   *
   * 每次调用刻意使用**不同参数**：这个 fixture 关心的是重规划抖动，而不是重复调用；
   * 完全相同的调用现在会被 `repeatGuard` 拦下（见 agent-loop 的重复调用守卫）。
   */
  function blockedRun() {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const draft = makeDraft({ steps: [{ id: "step-1", title: "读取 package.json" }] });
    const observationFor = (index: number): string =>
      JSON.stringify({ ok: true, data: { echoed: `hi-${index}` } });
    const evaluations = [1, 2, 3, 4].map((index) => ({
      completed: false,
      evidence: [observationFor(index)],
      passedCriteria: [] as string[],
      replanReason: "failed_assumption" as const,
    }));
    const model = new FakeModelDriver(
      [1, 2, 3, 4].map((index) =>
        turnWithTools({
          callId: `call-${index}`,
          name: "echo",
          argumentsJson: JSON.stringify({ value: `hi-${index}` }),
        }),
      ),
    );

    return createDeepSeekAgentCli({
      env: {},
      stdout: (text) => void stdout.push(text),
      stderr: (text) => void stderr.push(text),
      deps: {
        model,
        planner: new ScriptedPlanner(draft, evaluations, draft),
        tools: createRegistry(echoTool),
        store: new InMemoryRunStore(),
      },
    }).then((cli) => ({ cli, stdout, stderr }));
  }

  it("在 blocked_plan 停止时把阻塞原因与步骤 id 写进汇总", async () => {
    const { cli, stderr } = await blockedRun();

    const code = await cli(["run", "读取 package.json", "--verbose"]);

    expect(code).toBe(EXIT_CODES.failed);
    const joined = stderr.join("\n");
    expect(joined).toContain("[event] run_stopped reason=blocked_plan");
    expect(joined).toContain("[summary] blocked:");
    expect(joined).toContain("step-1");
  });

  it("关闭 verbose 时阻塞运行没有额外的订阅输出", async () => {
    const { cli, stderr } = await blockedRun();

    const code = await cli(["run", "读取 package.json"]);

    expect(code).toBe(EXIT_CODES.failed);
    for (const line of stderr) {
      expect(line.startsWith("[event] ")).toBe(false);
      expect(line.startsWith("[tool] ")).toBe(false);
      expect(line.startsWith("[summary] ")).toBe(false);
    }
    // 默认路径仍然只有 canonicalJson 事件行 + 一条摘要。
    expect(stderr.at(-1)).toContain('"stopReason":"blocked_plan"');
  });

  /**
   * 预算耗尽（`max_steps` / `max_tool_calls`）也必须能回答"卡在哪、最后做了什么、
   * 还差什么"：一次运行里同时出现 `[summary] stopped:` / `stopped detail:` / `hint:`
   * 与既有的 `[summary] usage` 行。
   */
  function budgetRun(input: { calls?: Array<{ callId: string; argumentsJson: string }> } = {}) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const draft = makeDraft({
      steps: [
        { id: "step-1", title: "读取 package.json" },
        { id: "step-2", title: "总结发现的脚本" },
      ],
    });
    const calls = input.calls ?? [{ callId: "call-1", argumentsJson: '{"value":"hi"}' }];
    const model = new FakeModelDriver([
      turnWithTools(
        ...calls.map((call) => ({
          callId: call.callId,
          name: "echo",
          argumentsJson: call.argumentsJson,
        })),
      ),
    ]);

    return createDeepSeekAgentCli({
      env: {},
      stdout: (text) => void stdout.push(text),
      stderr: (text) => void stderr.push(text),
      deps: {
        model,
        planner: new ScriptedPlanner(draft, [notCompleted()]),
        tools: createRegistry(echoTool),
        store: new InMemoryRunStore(),
      },
    }).then((cli) => ({ cli, stdout, stderr }));
  }

  it("max_steps 停止时同一次输出里有 stopped / detail / hint 与 usage 行", async () => {
    const { cli, stderr } = await budgetRun();

    const code = await cli(["run", "读取 package.json", "--verbose", "--max-steps", "1"]);

    expect(code).toBe(EXIT_CODES.failed);
    const joined = stderr.join("\n");
    expect(joined).toContain("[summary] stopped: max_steps (modelSteps=1/1, toolCalls=1/32)");
    expect(joined).toContain("[summary] stopped detail: active=step-1(status=in_progress)");
    expect(joined).toContain("last tools=echo(ok)");
    expect(joined).toContain("pending=step-1, step-2");
    expect(joined).toContain("[summary] hint: 预算耗尽但计划未完成，可提高 --max-steps 或拆分任务");
    // 既有的 usage 行必须与诊断在同一次输出里，且 hint 收尾。
    expect(joined).toContain("[summary] usage modelCalls=1 toolCalls=1");
    expect(joined.indexOf("[summary] hint:")).toBeGreaterThan(joined.indexOf("[summary] usage"));
  });

  /** 价格 $1/token：`inputTokens: 1` 就是 $1，算术一眼可验。 */
  const ONE_DOLLAR_PER_TOKEN = JSON.stringify({
    asOf: "2024-01-01",
    models: {
      "test-model": {
        inputPerMillionUsd: 1_000_000,
        outputPerMillionUsd: 0,
        asOf: "2024-01-01",
      },
    },
  });

  it("--max-cost-usd 越过上限时停止，并在汇总里给出上限与提示", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const model = new FakeModelDriver([
      withUsage(
        turnWithTools({ callId: "call-1", name: "echo", argumentsJson: '{"value":"hi"}' }),
        {
          inputTokens: 1,
          outputTokens: 0,
        },
      ),
    ]);
    const cli = await createDeepSeekAgentCli({
      env: { DEEPSEEK_PRICE_TABLE_JSON: ONE_DOLLAR_PER_TOKEN },
      stdout: (text) => void stdout.push(text),
      stderr: (text) => void stderr.push(text),
      deps: {
        model,
        modelId: "test-model",
        planner: new ScriptedPlanner(makeDraft({}), [notCompleted()]),
        tools: createRegistry(echoTool),
        store: new InMemoryRunStore(),
      },
    });

    const code = await cli(["run", "花钱", "--verbose", "--max-cost-usd", "0.5"]);

    expect(code).toBe(EXIT_CODES.failed);
    const joined = stderr.join("\n");
    expect(joined).toContain("stopped: max_cost");
    expect(joined).toContain("[summary] stopped detail:");
    expect(joined).toContain("hint:");
    expect(joined).toContain("--max-cost-usd");
  });

  it("--max-wall-ms 越过上限时停止", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let nowMs = Date.parse("2024-01-01T00:00:00.000Z");
    const model = new FakeModelDriver([textTurn("太久了")]);
    const cli = await createDeepSeekAgentCli({
      env: {},
      stdout: (text) => void stdout.push(text),
      stderr: (text) => void stderr.push(text),
      deps: {
        model,
        planner: new CompletingPlanner(makeDraft({}), ["criterion-1"]),
        tools: createRegistry(echoTool),
        store: new InMemoryRunStore(),
        clock: {
          now: () => {
            nowMs += 10_000;
            return new Date(nowMs);
          },
        },
      },
    });

    const code = await cli(["run", "跑太久", "--verbose", "--max-wall-ms", "5000"]);

    expect(code).toBe(EXIT_CODES.failed);
    const joined = stderr.join("\n");
    expect(joined).toContain("stopped: max_wall_ms");
    expect(joined).toContain("--max-wall-ms");
  });

  it("重复调用的 max_steps 运行给出重复提示，并把 budget_exhausted 写进 JSONL", async () => {
    const directory = await makeTempDir("agent-budget-");
    try {
      const logPath = join(directory, "journal.jsonl");
      const { cli, stderr } = await budgetRun({
        calls: [1, 2, 3].map((index) => ({
          callId: `call-${index}`,
          argumentsJson: '{"value":"hi"}',
        })),
      });

      const code = await cli([
        "run",
        "读取 package.json",
        "--verbose",
        "--log",
        logPath,
        "--max-steps",
        "1",
      ]);

      expect(code).toBe(EXIT_CODES.failed);
      const joined = stderr.join("\n");
      expect(joined).toContain("[summary] stopped: max_steps");
      expect(joined).toContain("repeated=echo x2");
      expect(joined).toContain("[summary] hint: 模型在重复同一个工具调用，考虑检查 observation");
      expect(joined).toContain("[budget] exhausted reason=max_steps");

      const records = (await readFile(logPath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const budget = records.find((record) => record["kind"] === "budget_exhausted");
      expect(budget).toBeDefined();
      expect(budget?.["reason"]).toBe("max_steps");
      expect(budget?.["budget"]).toEqual({
        modelSteps: 1,
        maxSteps: 1,
        toolCalls: 3,
        maxToolCalls: 32,
      });
      expect(Array.isArray(budget?.["recentToolCalls"])).toBe(true);
      expect(budget?.["lastReplanReason"]).toBeUndefined();
    } finally {
      await removeTempDir(directory);
    }
  });

  /** 计数工具：整条 CLI 链路里断言 `--no-repeat-guard` 真的改变行为。 */
  function repeatGuardRun() {
    const executed: string[] = [];
    const tool = defineTool({
      name: "count_echo",
      description: "Echo a value and count every execution.",
      effect: "read",
      schema: z.object({ value: z.string().min(1) }).strict(),
      async execute(input) {
        executed.push(input.value);
        return { echoed: input.value };
      },
    });
    const turns = [1, 2, 3].map((index) =>
      turnWithTools({
        callId: `call-${index}`,
        name: "count_echo",
        argumentsJson: '{"value":"same"}',
      }),
    );
    const stdout: string[] = [];
    const stderr: string[] = [];

    return createDeepSeekAgentCli({
      env: {},
      stdout: (text) => void stdout.push(text),
      stderr: (text) => void stderr.push(text),
      deps: {
        model: new FakeModelDriver(turns),
        planner: new ScriptedPlanner(makeDraft({}), [
          notCompleted(),
          notCompleted(),
          notCompleted(),
        ]),
        tools: createRegistry(tool),
        store: new InMemoryRunStore(),
      },
    }).then((cli) => ({ cli, executed, stderr }));
  }

  it("--no-repeat-guard 关闭守卫后，重复的同一调用照常执行", async () => {
    const guarded = await repeatGuardRun();
    await guarded.cli(["run", "任务", "--max-steps", "3"]);
    expect(guarded.executed).toEqual(["same", "same"]);

    const unguarded = await repeatGuardRun();
    const code = await unguarded.cli(["run", "任务", "--max-steps", "3", "--no-repeat-guard"]);
    expect(code).toBe(EXIT_CODES.failed);
    expect(unguarded.executed).toEqual(["same", "same", "same"]);
  });

  it("对超长 observation 与过多观测条数都做有界处理", async () => {
    const blob = "x".repeat(1500);
    // 每次调用刻意使用不同参数，避免触发重复调用守卫（这个用例只验证有界输出）。
    const calls = Array.from({ length: 25 }, (_, index) => ({
      callId: `call-${index + 1}`,
      name: "huge",
      argumentsJson: JSON.stringify({ size: 1500 - index }),
    }));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const cli = await createDeepSeekAgentCli({
      env: {},
      stdout: (text) => void stdout.push(text),
      stderr: (text) => void stderr.push(text),
      deps: {
        model: new FakeModelDriver([turnWithTools(...calls), textTurn("读取完成。")]),
        planner: new CompletingPlanner(makeDraft({}), ["criterion-1"]),
        tools: createRegistry(hugeTool),
        store: new InMemoryRunStore(),
      },
    });

    const code = await cli(["run", "读取大文件", "--verbose"]);

    expect(code).toBe(EXIT_CODES.completed);
    expect(stdout).toEqual(["读取完成。"]);

    const joined = stderr.join("\n");
    // 完整日志（journal）会原样打印 observation；这里只断言既有的**有界摘要**仍然守住上限。
    // 观测摘要行的形状固定为 `[tool] <name> callId=... chars=... preview=...`。
    const observationLines = stderr.filter(
      (line) => line.includes(" chars=") && line.includes("preview="),
    );
    const observations = observationLines.join("\n");

    // 单条详情截断：完整的长串不会出现，只保留前缀。
    expect(observations).not.toContain(blob);
    expect(observations).not.toContain("x".repeat(MAX_VERBOSE_DETAIL_CHARACTERS + 1));
    expect(observations).toContain("x".repeat(100));

    // 观测条数上限：25 条只打印 20 条，其余折叠成一行提示。
    expect(observationLines).toHaveLength(MAX_VERBOSE_TOOL_OBSERVATIONS);
    expect(joined).toContain("omitted 5");
    for (const line of observationLines) {
      // 一行最多带三个详情：`error=<code>`、截断的 `reason=` 与 `preview=`。
      expect(line.length).toBeLessThanOrEqual(
        MAX_VERBOSE_DETAIL_CHARACTERS + MAX_VERBOSE_REASON_CHARACTERS + 200,
      );
    }
  });

  /**
   * `plan_revised` 反复出现却"不说为什么、改了什么"是这次修复的对象：
   * verbose 行与 `--log` JSONL 都必须带上有界的 reason + 计划差异 + 触发证据。
   */
  function reviseRun() {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const draft = makeDraft({ steps: [{ id: "step-1", title: "读取 package.json" }] });
    const revised = makeDraft({
      steps: [
        { id: "step-1", title: "读取并解释 package.json" },
        { id: "step-2", title: "总结发现的脚本" },
      ],
    });
    const failureObservation = JSON.stringify({
      ok: false,
      error: "tool_error",
      message: "tool exploded",
    });
    const evaluations = [1, 2, 3, 4].map(() => ({
      completed: false,
      evidence: [failureObservation],
      passedCriteria: [] as string[],
      replanReason: "failed_assumption" as const,
    }));
    const model = new FakeModelDriver(
      [1, 2, 3, 4].map((index) =>
        turnWithTools({
          callId: `call-${index}`,
          name: "boom",
          argumentsJson: "{}",
        }),
      ),
    );

    return createDeepSeekAgentCli({
      env: {},
      stdout: (text) => void stdout.push(text),
      stderr: (text) => void stderr.push(text),
      deps: {
        model,
        planner: new ScriptedPlanner(draft, evaluations, revised),
        tools: createRegistry(failingTool),
        store: new InMemoryRunStore(),
      },
    }).then((cli) => ({ cli, stdout, stderr }));
  }

  it("plan_revised 行带上 reason / 计划差异 / 最近失败工具，JSONL 同样有 detail", async () => {
    const directory = await makeTempDir("agent-revise-");
    try {
      const logPath = join(directory, "journal.jsonl");
      const { cli, stderr } = await reviseRun();

      const code = await cli(["run", "读取 package.json", "--verbose", "--log", logPath]);

      expect(code).toBe(EXIT_CODES.failed);
      const joined = stderr.join("\n");
      expect(joined).toContain(
        "[event] plan_revised version=2 reason=failed_assumption added=step-2 removed=(none) renamed=step-1 dependsChanged=0 failed=boom:tool_error",
      );
      // 工具失败的 [summary] 行不再只有 ok=false。
      expect(joined).toContain("[tool] boom callId=call-1");
      expect(joined).toContain("ok=false error=tool_error reason=tool exploded");

      const records = (await readFile(logPath, "utf8"))
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const revisedRecords = records.filter((record) => record["kind"] === "plan_revised");
      expect(revisedRecords.length).toBeGreaterThan(0);
      expect(revisedRecords[0]).toMatchObject({
        version: 2,
        reason: "failed_assumption",
        detail: {
          type: "plan_revised",
          addedSteps: ["step-2"],
          renamedSteps: ["step-1"],
          dependencyChanges: 0,
          recentFailures: [{ name: "boom", errorCode: "tool_error" }],
        },
      });
      const failureResult = records.find(
        (record) => record["kind"] === "tool_result" && record["ok"] === false,
      );
      expect(failureResult?.["error"]).toBe("tool_error");
      expect(failureResult?.["reason"]).toBe("tool exploded");
    } finally {
      await removeTempDir(directory);
    }
  });

  it("默认路径的 plan_revised 事件行保持既有字段集（不含 detail）", async () => {
    const { cli, stderr } = await reviseRun();

    await cli(["run", "读取 package.json"]);

    const eventLines = stderr.filter((line) => line.includes('"type":"plan_revised"'));
    expect(eventLines.length).toBeGreaterThan(0);
    for (const line of eventLines) {
      // 逐字节冻结：默认事件流只有 type / version / reason。
      expect(line).toMatch(/^\{"reason":"[^"]+","type":"plan_revised","version":\d+\}$/);
    }
    expect(stderr.join("\n")).not.toContain("[usage]");
    expect(stderr.join("\n")).not.toContain("[summary]");
  });

  it("工具失败原因过长时在 [summary] 行里同样被截断", async () => {
    const longMessage = "y".repeat(5_000);
    const stdout: string[] = [];
    const stderr: string[] = [];
    // 工具的异常 message 会被 executor 截到 500 字符，再被 verbose 行截到
    // MAX_VERBOSE_REASON_CHARACTERS：整行因此始终有界。
    const longFailureTool = defineTool({
      name: "boom",
      description: "Always fails with a very long message.",
      effect: "read",
      schema: z.object({}).strict(),
      async execute() {
        throw new Error(longMessage);
      },
    });
    const cli = await createDeepSeekAgentCli({
      env: {},
      stdout: (text) => void stdout.push(text),
      stderr: (text) => void stderr.push(text),
      deps: {
        model: new FakeModelDriver([
          turnWithTools({ callId: "call-1", name: "boom", argumentsJson: "{}" }),
        ]),
        planner: new ScriptedPlanner(makeDraft({}), [notCompleted()]),
        tools: createRegistry(longFailureTool),
        store: new InMemoryRunStore(),
      },
    });

    await cli(["run", "任务", "--verbose", "--max-steps", "1"]);

    const observationLines = stderr.filter(
      (line) => line.includes(" chars=") && line.includes("preview="),
    );
    const line = observationLines.at(-1) ?? "";
    expect(line).toContain("error=tool_error reason=");
    expect(line).not.toContain(longMessage);
    expect(line).not.toContain("y".repeat(500));
    expect(line).toContain("y".repeat(MAX_VERBOSE_REASON_CHARACTERS));
  });
});

describe("usage 与成本", () => {
  interface UsageReplies {
    first?: ModelUsage | undefined;
    second?: ModelUsage | undefined;
  }

  /** 假 Responses 客户端：首轮请求工具、次轮给最终答案，两轮都可以带 usage。 */
  function usageCli(input: {
    env?: NodeJS.ProcessEnv | undefined;
    usage?: UsageReplies | undefined;
  }) {
    const usage = input.usage ?? {
      first: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 40 },
      second: { inputTokens: 200, outputTokens: 20, cachedInputTokens: 60 },
    };
    const { client } = scriptedResponsesClient([
      {
        id: "response-1",
        output_text: "",
        output: [
          { type: "function_call", call_id: "call-1", name: "echo", arguments: '{"value":"hi"}' },
        ],
        ...(usage.first === undefined ? {} : { usage: usage.first }),
      },
      {
        id: "response-2",
        output_text: "项目使用 pnpm。",
        output: [],
        ...(usage.second === undefined ? {} : { usage: usage.second }),
      },
    ]);

    const stdout: string[] = [];
    const stderr: string[] = [];

    return createDeepSeekAgentCli({
      env: input.env ?? {},
      stdout: (text) => void stdout.push(text),
      stderr: (text) => void stderr.push(text),
      deps: {
        model: createStatelessResponsesDriver({ client, modelId: "deepseek-v4-flash" }),
        modelId: "deepseek-v4-flash",
        planner: new CompletingPlanner(makeDraft({}), ["criterion-1"]),
        tools: createRegistry(echoTool),
        store: new InMemoryRunStore(),
      },
    }).then((cli) => ({ cli, stdout, stderr }));
  }

  async function readRecords(path: string): Promise<Record<string, unknown>[]> {
    return (await readFile(path, "utf8"))
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  it("把 provider usage 透传到每次调用与运行汇总（含 --log JSONL）", async () => {
    const directory = await makeTempDir("agent-usage-");
    try {
      const logPath = join(directory, "journal.jsonl");
      const { cli, stdout, stderr } = await usageCli({});

      const code = await cli(["run", "读取 package.json", "--verbose", "--log", logPath]);

      expect(code).toBe(EXIT_CODES.completed);
      expect(stdout).toEqual(["项目使用 pnpm。"]);

      const joined = stderr.join("\n");
      expect(joined).toMatch(
        /\[usage\] step=1 phase=start in=100 out=10 cached=40 durationMs=\d+ model=deepseek-v4-flash cost=\$\d/,
      );
      expect(joined).toMatch(
        /\[usage\] step=2 phase=continue in=200 out=20 cached=60 durationMs=\d+ model=deepseek-v4-flash/,
      );
      expect(joined).toMatch(
        /\[usage\] run: modelCalls=2 toolCalls=1 in=300 out=30 cached=100 wallMs=\d+ cost=\$\d+\.\d{6} \(prices asOf=2026-08-23, source=https:\/\/api-docs\.deepseek\.com\/quick_start\/pricing \(peak rates; off-peak is half\); cache hits billed separately\)/,
      );
      expect(joined).toContain(
        "[summary] usage modelCalls=2 toolCalls=1 in=300 out=30 cached=100 wallMs=",
      );

      const usageRecords = (await readRecords(logPath)).filter(
        (record) => record["kind"] === "usage",
      );
      expect(usageRecords.map((record) => record["scope"])).toEqual(["model", "model", "run"]);
      expect(usageRecords[0]).toMatchObject({
        scope: "model",
        step: 1,
        phase: "start",
        model: "deepseek-v4-flash",
        inputTokens: 100,
        outputTokens: 10,
        cachedInputTokens: 40,
      });
      expect(usageRecords[2]).toMatchObject({
        scope: "run",
        modelCalls: 2,
        toolCalls: 1,
        inputTokens: 300,
        outputTokens: 30,
        cachedInputTokens: 100,
      });
      expect(typeof usageRecords[2]?.["costUsd"]).toBe("number");
      expect(usageRecords[2]?.["prices"]).toMatchObject({ asOf: "2026-08-23" });
    } finally {
      await removeTempDir(directory);
    }
  });

  it("provider 不返回 usage 时显示 unknown，而不是 0", async () => {
    const directory = await makeTempDir("agent-usage-unknown-");
    try {
      const logPath = join(directory, "journal.jsonl");
      const { cli, stderr } = await usageCli({ usage: { first: undefined, second: undefined } });

      const code = await cli(["run", "读取 package.json", "--verbose", "--log", logPath]);

      expect(code).toBe(EXIT_CODES.completed);
      const joined = stderr.join("\n");
      expect(joined).toMatch(
        /\[usage\] step=1 phase=start in=unknown out=unknown cached=unknown durationMs=\d+ model=deepseek-v4-flash cost=unknown/,
      );
      expect(joined).toMatch(
        /\[usage\] run: modelCalls=2 toolCalls=1 in=unknown out=unknown cached=unknown wallMs=\d+ cost=unknown/,
      );
      expect(joined).toContain(
        "[summary] usage modelCalls=2 toolCalls=1 in=unknown out=unknown cached=unknown",
      );
      // 汇总行里绝不出现"0"冒充未知。
      expect(joined).not.toContain("in=0 out=0 cached=0");

      const runRecord = (await readRecords(logPath)).find(
        (record) => record["kind"] === "usage" && record["scope"] === "run",
      );
      expect(runRecord).toMatchObject({ modelCalls: 2, toolCalls: 1 });
      expect(runRecord).not.toHaveProperty("inputTokens");
      expect(runRecord).not.toHaveProperty("outputTokens");
      expect(runRecord).not.toHaveProperty("cachedInputTokens");
      expect(runRecord).not.toHaveProperty("costUsd");
    } finally {
      await removeTempDir(directory);
    }
  });

  it("DEEPSEEK_PRICE_TABLE_JSON 覆盖生效：成本用注入的价目表算", async () => {
    const { cli, stderr } = await usageCli({
      env: { DEEPSEEK_PRICE_TABLE_JSON: JSON.stringify(TEST_PRICE_TABLE) },
      // 1M input（250k 命中缓存）+ 1M output；第二轮补 0。
      usage: {
        first: { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedInputTokens: 250_000 },
        second: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      },
    });

    const code = await cli(["run", "读取 package.json", "--verbose"]);

    expect(code).toBe(EXIT_CODES.completed);
    const joined = stderr.join("\n");
    // 750k * $100/1M + 250k * $10/1M + 1M * $200/1M = 75 + 2.5 + 200
    expect(joined).toContain("in=1000000 out=1000000 cached=250000");
    expect(joined).toContain("cost=$277.500000");
    expect(joined).toContain(
      "(prices asOf=2024-01-01, source=https://example.test/pricing; cache hits billed separately)",
    );
  });

  it("价格表解析失败时报可读错误，而不是静默用内置表", async () => {
    const { cli } = await usageCli({ env: { DEEPSEEK_PRICE_TABLE_JSON: "{not json" } });

    await expect(cli(["run", "读取 package.json"])).rejects.toThrow(
      /DEEPSEEK_PRICE_TABLE_JSON 不是合法 JSON/,
    );
  });

  it("未接线模型 id 时成本保持 unknown（不会拿内置价目表硬套）", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const cli = await createDeepSeekAgentCli({
      env: {},
      stdout: (text) => void stdout.push(text),
      stderr: (text) => void stderr.push(text),
      deps: {
        model: new FakeModelDriver([
          turnWithTools({ callId: "call-1", name: "echo", argumentsJson: '{"value":"hi"}' }),
          textTurn("项目使用 pnpm。"),
        ]),
        planner: new CompletingPlanner(makeDraft({}), ["criterion-1"]),
        tools: createRegistry(echoTool),
        store: new InMemoryRunStore(),
      },
    });

    const code = await cli(["run", "读取 package.json", "--verbose"]);

    expect(code).toBe(EXIT_CODES.completed);
    const joined = stderr.join("\n");
    expect(joined).toContain("[usage] step=1 phase=start");
    expect(joined).toContain("model=unknown cost=unknown");
    expect(joined).toMatch(/\[usage\] run: modelCalls=2 toolCalls=1 in=unknown out=unknown/);
    expect(joined).toContain("cost=unknown");
  });

  /**
   * 用量放在 `AgentState.usage`（随检查点持久化）而不是 `AgentResult.usage`，
   * 所以 `answer` / `resume` 之后是**接着涨**，而不是从 0 重来。
   */
  it("resume 后继续累计 usage，而不是从 0 重来", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const cli = await createDeepSeekAgentCli({
      env: {},
      stdout: (text) => void stdout.push(text),
      stderr: (text) => void stderr.push(text),
      deps: {
        model: new FakeModelDriver([
          withUsage(pendingInputTurn(), {
            inputTokens: 100,
            outputTokens: 10,
            cachedInputTokens: 40,
          }),
          withUsage(
            turnWithTools({ callId: "call-1", name: "echo", argumentsJson: '{"value":"hi"}' }),
            { inputTokens: 200, outputTokens: 20, cachedInputTokens: 50 },
          ),
          withUsage(textTurn("项目使用 pnpm。"), {
            inputTokens: 300,
            outputTokens: 30,
            cachedInputTokens: 60,
          }),
        ]),
        modelId: "deepseek-v4-flash",
        planner: new CompletingPlanner(makeDraft({}), ["criterion-1"]),
        tools: createRegistry(echoTool),
        store: new InMemoryRunStore(),
      },
    });

    const runCode = await cli(["run", "读取 package.json", "--verbose"]);
    expect(runCode).toBe(EXIT_CODES.waiting);
    expect(stderr.join("\n")).toMatch(
      /\[usage\] run: modelCalls=1 toolCalls=0 in=100 out=10 cached=40 wallMs=/,
    );

    const runId = runIdFromStderr(stderr);
    const answerCode = await cli(["answer", runId, "request-1", "用 pnpm", "--verbose"]);

    expect(answerCode).toBe(EXIT_CODES.completed);
    // 100+200+300 / 10+20+30 / 40+50+60：第一段的用量没有被清零。
    expect(stderr.join("\n")).toMatch(
      /\[usage\] run: modelCalls=3 toolCalls=1 in=600 out=60 cached=150 wallMs=/,
    );
  });
});

describe("createVerboseObserver", () => {
  it("打印 plan_revised 并把 changedFiles / trace 列表折叠到有界长度", () => {
    const lines: string[] = [];
    const observer = createVerboseObserver((line) => void lines.push(line));

    const state = createInitialState("任务", "/workspace");
    state.changedFiles.push(
      "z".repeat(MAX_VERBOSE_DETAIL_CHARACTERS + 300),
      ...Array.from({ length: 25 }, (_, index) => `src/file-${index + 1}.ts`),
    );

    observer.onEvent({ type: "run_started", runId: "run-1" });
    observer.onEvent({ type: "plan_revised", version: 3, reason: "failed_assumption" });
    for (let step = 1; step <= 22; step += 1) {
      observer.onEvent({ type: "model_started", step });
    }
    observer.onEvent({ type: "run_stopped", reason: "final_answer" });
    observer.finish({ status: "completed", answer: "答案", stopReason: "final_answer", state });

    const joined = lines.join("\n");
    expect(joined).toContain("[event] plan_revised version=3 reason=failed_assumption");
    expect(joined).toContain("[event] run_stopped reason=final_answer");
    expect(joined).toContain("stopReason=final_answer");
    expect(joined).toContain("budget modelSteps=0/12 toolCalls=0/24");
    // 26 个 changedFiles 只列前 20 个，超长路径同样被截断。
    expect(joined).not.toContain("z".repeat(MAX_VERBOSE_DETAIL_CHARACTERS + 1));
    expect(joined).toContain("z".repeat(MAX_VERBOSE_DETAIL_CHARACTERS));
    expect(joined).toContain("changedFiles=");
    expect(joined).toContain("(+6 more)");
    // 25 条事件类型只列前 20 条。
    expect(joined).toContain("trace=run_started,plan_revised,model_started");
    expect(joined).toContain("(+5 more)");
  });
});
