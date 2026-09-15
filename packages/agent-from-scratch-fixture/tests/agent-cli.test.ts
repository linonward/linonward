import { describe, expect, it } from "vitest";

import {
  AGENT_DEFAULT_MAX_STEPS,
  AGENT_DEFAULT_MAX_TOOL_CALLS,
  AGENT_USAGE,
  createDeepSeekAgentCli,
  parseAgentArgs,
} from "../src/agent-cli.js";
import { FakeModelDriver, textTurn, turnWithTools, userInputTurn } from "../src/fake-model.js";
import { EXIT_CODES } from "../src/index.js";
import { InMemoryRunStore } from "../src/run-store.js";
import { CompletingPlanner, createRegistry, echoTool, makeDraft } from "./support.js";

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
    });
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
