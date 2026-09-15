import { describe, expect, it } from "vitest";

import { runAgentLoop } from "../src/agent-loop.js";
import {
  CLI_USAGE,
  type CliRuntime,
  type CliRuntimeInput,
  EXIT_CODES,
  exitCodeFor,
  parseCliArgs,
  runCli,
} from "../src/index.js";
import { InMemoryTraceSink } from "../src/trace.js";
import type { AgentResult, AgentState, StopReason } from "../src/types.js";
import {
  CompletingPlanner,
  createRegistry,
  echoTool,
  makeDraft,
  makeTempDir,
  removeTempDir,
} from "./support.js";

function fakeResult(input: {
  runId: string;
  status: AgentState["status"];
  stopReason: StopReason;
  answer?: string;
  changedFiles?: string[];
}): AgentResult {
  const state = {
    runId: input.runId,
    task: "任务",
    cwd: "/workspace",
    status: input.status,
    messages: [],
    contextSources: [],
    steps: [],
    changedFiles: input.changedFiles ?? [],
    changedFileHashes: {},
    mutationRevision: 0,
    validations: [],
    requiredCriterionIds: [],
    failedAttempts: [],
    budget: { maxSteps: 1, maxToolCalls: 1, modelSteps: 0, toolCalls: 0 },
    events: [],
    nextEventSequence: 1,
    stopReason: input.stopReason,
    plan: undefined,
    activeStepId: undefined,
    planHistory: [],
    pendingUserInput: undefined,
    goalVersion: 1,
    constraints: [],
    skills: { catalog: [], activeSkills: {} },
    compaction: { snapshots: [], compactedThroughEvent: 0 },
  } satisfies AgentState;

  return {
    status: input.status,
    answer: input.answer ?? "",
    stopReason: input.stopReason,
    state,
  };
}

function harness(runtime: Partial<CliRuntime>) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const seen: AgentLoopEventRecord[] = [];

  return {
    io: {
      stdout: (text: string) => void stdout.push(text),
      stderr: (text: string) => void stderr.push(text),
    },
    stdout,
    stderr,
    seen,
    dependencies: {
      createRuntime(input: CliRuntimeInput): CliRuntime {
        seen.push({ skillsDirectory: input.skillsDirectory, signal: input.signal });
        return {
          run:
            runtime.run ??
            (async (task) => {
              input.onEvent({ type: "run_started", runId: "run-1" });
              return fakeResult({
                runId: "run-1",
                status: "completed",
                stopReason: "final_answer",
                answer: task,
              });
            }),
          resume:
            runtime.resume ??
            (async (runId) =>
              fakeResult({ runId, status: "completed", stopReason: "final_answer" })),
          answer:
            runtime.answer ??
            (async (runId) =>
              fakeResult({ runId, status: "completed", stopReason: "final_answer" })),
        };
      },
    },
  };
}

interface AgentLoopEventRecord {
  skillsDirectory: string;
  signal: AbortSignal;
}

describe("cli argument parsing", () => {
  it("parses the three subcommands", () => {
    expect(parseCliArgs(["run", "分析", "这个仓库"])).toEqual({
      command: "run",
      task: "分析 这个仓库",
    });
    expect(parseCliArgs(["resume", "run-1"])).toEqual({ command: "resume", runId: "run-1" });
    expect(parseCliArgs(["answer", "run-1", "request-1", "默认", "用户名"])).toEqual({
      command: "answer",
      runId: "run-1",
      requestId: "request-1",
      content: "默认 用户名",
    });
  });

  it("rejects missing or malformed arguments with the usage message", () => {
    for (const argv of [[], ["run"], ["resume"], ["resume", "a", "b"], ["answer", "r"], ["nope"]]) {
      expect(() => parseCliArgs(argv)).toThrow(CLI_USAGE);
    }
  });
});

describe("cli exit codes", () => {
  it("maps every terminal status to a distinct code", () => {
    expect(
      exitCodeFor(fakeResult({ runId: "r", status: "completed", stopReason: "final_answer" })),
    ).toBe(0);
    expect(
      exitCodeFor(fakeResult({ runId: "r", status: "failed", stopReason: "model_error" })),
    ).toBe(1);
    expect(
      exitCodeFor(fakeResult({ runId: "r", status: "blocked", stopReason: "blocked_plan" })),
    ).toBe(1);
    expect(
      exitCodeFor(fakeResult({ runId: "r", status: "waiting", stopReason: "approval_required" })),
    ).toBe(3);
    expect(
      exitCodeFor(fakeResult({ runId: "r", status: "cancelled", stopReason: "cancelled" })),
    ).toBe(130);
  });

  it("prints the answer, streams onEvent to stderr and returns 0", async () => {
    const fixture = harness({});

    const code = await runCli(["run", "解释 package.json"], fixture.dependencies, fixture.io);

    expect(code).toBe(EXIT_CODES.completed);
    expect(fixture.stdout).toEqual(["解释 package.json"]);
    expect(fixture.stderr[0]).toContain('"type":"run_started"');
    expect(fixture.stderr.at(-1)).toContain('"stopReason":"final_answer"');
    expect(fixture.seen[0]?.signal.aborted).toBe(false);
  });

  it("returns the usage code without creating a runtime", async () => {
    const fixture = harness({});

    const code = await runCli([], fixture.dependencies, fixture.io);

    expect(code).toBe(EXIT_CODES.usage);
    expect(fixture.stderr).toEqual([CLI_USAGE]);
    expect(fixture.seen).toHaveLength(0);
  });

  it("routes answer through the runtime with the request id", async () => {
    const answers: string[] = [];
    const fixture = harness({
      async answer(runId, answer) {
        answers.push(`${runId}:${answer.requestId}:${answer.content}`);
        return fakeResult({
          runId,
          status: "waiting",
          stopReason: "user_input_required",
        });
      },
    });

    const code = await runCli(
      ["answer", "run-7", "request-9", "使用当前用户名"],
      fixture.dependencies,
      fixture.io,
    );

    expect(code).toBe(EXIT_CODES.waiting);
    expect(answers).toEqual(["run-7:request-9:使用当前用户名"]);
  });

  it("aborts the injected signal when the process receives SIGINT", async () => {
    const fixture = harness({
      async run() {
        process.emit("SIGINT");
        return fakeResult({ runId: "run-1", status: "cancelled", stopReason: "cancelled" });
      },
    });

    const code = await runCli(["run", "任务"], fixture.dependencies, fixture.io);

    expect(code).toBe(EXIT_CODES.cancelled);
    expect(fixture.seen[0]?.signal.aborted).toBe(true);
  });
});

describe("cli wiring with the real agent loop", () => {
  it("runs the offline loop end to end through the injected runtime", async () => {
    const cwd = await makeTempDir("agent-cli-");
    try {
      const planner = new CompletingPlanner(
        makeDraft({ steps: [{ id: "step-1", title: "读取文件" }] }),
        ["criterion-1"],
      );
      const tools = createRegistry(echoTool);

      const fixture = harness({
        async run(task) {
          return runAgentLoop(task, {
            cwd,
            skillsDirectory: cwd,
            maxSteps: 4,
            maxToolCalls: 4,
            toolTimeoutMs: 1_000,
            model: {
              async start() {
                return {
                  responseId: "response-1",
                  finalText: "",
                  toolCalls: [{ callId: "call-1", name: "echo", argumentsJson: '{"value":"hi"}' }],
                };
              },
              async continue() {
                return {
                  responseId: "response-2",
                  finalText: "完成",
                  toolCalls: [],
                };
              },
            },
            planner,
            tools,
            trace: new InMemoryTraceSink(),
          });
        },
      });

      const code = await runCli(["run", "读取文件"], fixture.dependencies, fixture.io);

      expect(code).toBe(EXIT_CODES.completed);
      expect(fixture.stdout).toEqual(["完成"]);
      expect(fixture.stderr.at(-1)).toContain('"status":"completed"');
    } finally {
      await removeTempDir(cwd);
    }
  });
});
