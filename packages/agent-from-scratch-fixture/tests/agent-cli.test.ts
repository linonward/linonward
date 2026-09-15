import { describe, expect, it } from "vitest";

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
  MAX_VERBOSE_TOOL_OBSERVATIONS,
} from "../src/cli-verbose.js";
import { FakeModelDriver, textTurn, turnWithTools, userInputTurn } from "../src/fake-model.js";
import { EXIT_CODES } from "../src/index.js";
import { InMemoryRunStore } from "../src/run-store.js";
import { createInitialState } from "../src/state.js";
import {
  CompletingPlanner,
  createRegistry,
  echoTool,
  hugeTool,
  makeDraft,
  ScriptedPlanner,
} from "./support.js";

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
    });
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

  /**
   * 计划反复修订却没有任何步骤完成：Loop 会以 `blocked_plan` 停止。
   * 这个 fixture 因此能在全离线条件下产生真实的 `plan_blocked` 事件。
   */
  function blockedRun() {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const draft = makeDraft({ steps: [{ id: "step-1", title: "读取 package.json" }] });
    const echoObservation = JSON.stringify({ ok: true, data: { echoed: "hi" } });
    const evaluations = [1, 2, 3, 4].map(() => ({
      completed: false,
      evidence: [echoObservation],
      passedCriteria: [] as string[],
      replanReason: "failed_assumption" as const,
    }));
    const model = new FakeModelDriver(
      [1, 2, 3, 4].map((index) =>
        turnWithTools({ callId: `call-${index}`, name: "echo", argumentsJson: '{"value":"hi"}' }),
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

  it("对超长 observation 与过多观测条数都做有界处理", async () => {
    const blob = "x".repeat(1500);
    const calls = Array.from({ length: 25 }, (_, index) => ({
      callId: `call-${index + 1}`,
      name: "huge",
      argumentsJson: '{"size":1500}',
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
    // 单条详情截断：完整的长串不会出现，只保留前缀。
    expect(joined).not.toContain(blob);
    expect(joined).not.toContain("x".repeat(MAX_VERBOSE_DETAIL_CHARACTERS + 1));
    expect(joined).toContain("x".repeat(100));

    // 观测条数上限：25 条只打印 20 条，其余折叠成一行提示。
    const toolLines = stderr.filter((line) => line.startsWith("[tool] "));
    expect(toolLines).toHaveLength(MAX_VERBOSE_TOOL_OBSERVATIONS);
    expect(joined).toContain("omitted 5");
    for (const line of toolLines) {
      expect(line.length).toBeLessThanOrEqual(MAX_VERBOSE_DETAIL_CHARACTERS + 200);
    }
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
