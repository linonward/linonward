import { afterEach, describe, expect, it } from "vitest";

import { type AgentLoopOptions, runAgentLoop, runAgentLoopFromState } from "../src/agent-loop.js";
import { isRecord, sha256 } from "../src/checkpoint.js";
import { FakeModelDriver, textTurn, turnWithTools } from "../src/fake-model.js";
import { InMemoryApprovalLedger, type PolicyContext } from "../src/policy.js";
import { createInitialState, transitionState } from "../src/state.js";
import { applyPatchTool } from "../src/tools/apply-patch.js";
import { readFileTool } from "../src/tools/read-file.js";
import { runCommandTool } from "../src/tools/run-command.js";
import { InMemoryTraceSink } from "../src/trace.js";
import type { ValidationSpec } from "../src/types.js";
import {
  CompletingPlanner,
  completeWith,
  createRegistry,
  criterion,
  echoTool,
  makeDraft,
  makeTaskPlan,
  makeTempDir,
  notCompleted,
  planStep,
  removeTempDir,
  ScriptedPlanner,
} from "./support.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeTempDir(directory)));
});

async function tempDir(): Promise<string> {
  const directory = await makeTempDir("agent-loop-");
  temporaryDirectories.push(directory);
  return directory;
}

type LoopOverrides = Pick<AgentLoopOptions, "model" | "planner" | "tools"> &
  Partial<AgentLoopOptions>;

function base(cwd: string, overrides: LoopOverrides): AgentLoopOptions {
  const options: AgentLoopOptions = {
    cwd,
    skillsDirectory: cwd,
    maxSteps: 8,
    maxToolCalls: 8,
    toolTimeoutMs: 2_000,
    trace: new InMemoryTraceSink(),
    model: overrides.model,
    planner: overrides.planner,
    tools: overrides.tools,
  };

  if (overrides.maxSteps !== undefined) options.maxSteps = overrides.maxSteps;
  if (overrides.maxToolCalls !== undefined) options.maxToolCalls = overrides.maxToolCalls;
  if (overrides.skillsDirectory !== undefined) options.skillsDirectory = overrides.skillsDirectory;
  if (overrides.toolTimeoutMs !== undefined) options.toolTimeoutMs = overrides.toolTimeoutMs;
  if (overrides.trace !== undefined) options.trace = overrides.trace;
  if (overrides.validationSpecs !== undefined) options.validationSpecs = overrides.validationSpecs;
  if (overrides.policy !== undefined) options.policy = overrides.policy;
  if (overrides.approvals !== undefined) options.approvals = overrides.approvals;
  if (overrides.writeLease !== undefined) options.writeLease = overrides.writeLease;
  if (overrides.clock !== undefined) options.clock = overrides.clock;
  if (overrides.signal !== undefined) options.signal = overrides.signal;
  if (overrides.onEvent !== undefined) options.onEvent = overrides.onEvent;
  return options;
}

const echoObservation = JSON.stringify({ ok: true, data: { echoed: "hi" } });
const echoCall = { callId: "call-1", name: "echo", argumentsJson: '{"value":"hi"}' };

/** `plan_blocked` 的 detail 是 JSON 文本：测试只按稳定字段读取，不做类型断言。 */
function parseDetail(detail: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(detail);
  if (!isRecord(parsed)) throw new Error("plan_blocked detail is not an object");
  return parsed;
}

function pendingStepOf(detail: Record<string, unknown>, id: string): Record<string, unknown> {
  const steps = detail["pendingSteps"];
  if (!Array.isArray(steps)) throw new Error("pendingSteps is not an array");
  for (const step of steps) {
    if (isRecord(step) && step["id"] === id) return step;
  }
  throw new Error(`pending step ${id} is missing`);
}

describe("agent loop control flow", () => {
  it("runs model → tool → observation → model → final", async () => {
    const cwd = await tempDir();
    const driver = new FakeModelDriver([
      turnWithTools(echoCall),
      textTurn("package.json defines the project scripts."),
    ]);
    const planner = new ScriptedPlanner(
      makeDraft({ steps: [{ id: "inspect", title: "读取 package.json" }] }),
      [completeWith([echoObservation], ["criterion-1"])],
    );

    const result = await runAgentLoop(
      "Explain package.json",
      base(cwd, { model: driver, planner, tools: createRegistry(echoTool) }),
    );

    expect(result.stopReason).toBe("final_answer");
    expect(result.status).toBe("completed");
    expect(result.state.steps.map((step) => step.kind)).toEqual(["model", "tool", "model"]);
    expect(result.state.contextSources.map((source) => source.kind)).toEqual(["tool_observation"]);
    expect(driver.calls[0]?.previousResponseId).toBe("response-tools:call-1");
    expect(driver.calls[0]?.outputs).toEqual([
      expect.objectContaining({ type: "function_call_output", call_id: "call-1" }),
    ]);
    expect(result.state.plan?.steps[0]).toMatchObject({ status: "completed" });
    expect(result.state.requiredCriterionIds).toEqual(["criterion-1"]);
  });

  it("rejects early completion and continues with harness feedback", async () => {
    const cwd = await tempDir();
    const driver = new FakeModelDriver([
      turnWithTools(echoCall),
      textTurn("我完成了。", "response-early"),
      turnWithTools({ ...echoCall, callId: "call-2" }),
      textTurn("最终答案", "response-final"),
    ]);
    const planner = new ScriptedPlanner(
      makeDraft({ steps: [{ id: "inspect", title: "读取 package.json" }] }),
      [notCompleted([echoObservation]), completeWith([echoObservation], ["criterion-1"])],
    );

    const result = await runAgentLoop(
      "Explain package.json",
      base(cwd, { model: driver, planner, tools: createRegistry(echoTool) }),
    );

    expect(result.stopReason).toBe("final_answer");
    expect(result.answer).toBe("最终答案");
    const feedback = result.state.contextSources.filter(
      (source) => source.kind === "harness_feedback",
    );
    expect(feedback).toHaveLength(1);
    expect(feedback[0]?.content).toContain("计划中仍有未完成的步骤");
    // 提前完成后必须重新 Assemble，而不是复用旧 response 链。
    expect(driver.turns.filter((turn) => turn.kind === "start")).toHaveLength(2);
    expect(driver.calls[0]?.previousResponseId).toBe("response-tools:call-1");
  });

  it("stops with max_steps and max_tool_calls for the matching budgets", async () => {
    const cwd = await tempDir();

    const noSteps = await runAgentLoop(
      "任务",
      base(cwd, {
        maxSteps: 0,
        model: new FakeModelDriver([]),
        planner: new ScriptedPlanner(makeDraft({})),
        tools: createRegistry(echoTool),
      }),
    );
    expect(noSteps.stopReason).toBe("max_steps");
    expect(noSteps.status).toBe("failed");

    const noTools = await runAgentLoop(
      "任务",
      base(cwd, {
        maxSteps: 4,
        maxToolCalls: 0,
        model: new FakeModelDriver([turnWithTools(echoCall)]),
        planner: new ScriptedPlanner(makeDraft({})),
        tools: createRegistry(echoTool),
      }),
    );
    expect(noTools.stopReason).toBe("max_tool_calls");
    expect(noTools.state.budget.toolCalls).toBe(0);
  });

  it("maps model failures, cancellation and evidence forgery to stable stop reasons", async () => {
    const cwd = await tempDir();

    const failed = await runAgentLoop(
      "任务",
      base(cwd, {
        model: new FakeModelDriver([]),
        planner: new ScriptedPlanner(makeDraft({})),
        tools: createRegistry(echoTool),
      }),
    );
    expect(failed.stopReason).toBe("model_error");

    const controller = new AbortController();
    controller.abort();
    const cancelled = await runAgentLoop(
      "任务",
      base(cwd, {
        signal: controller.signal,
        model: new FakeModelDriver([]),
        planner: new ScriptedPlanner(makeDraft({})),
        tools: createRegistry(echoTool),
      }),
    );
    expect(cancelled.stopReason).toBe("cancelled");

    const forged = await runAgentLoop(
      "任务",
      base(cwd, {
        model: new FakeModelDriver([turnWithTools(echoCall)]),
        planner: new ScriptedPlanner(makeDraft({}), [
          completeWith(["planner invented this evidence"], ["criterion-1"]),
        ]),
        tools: createRegistry(echoTool),
      }),
    );
    expect(forged.stopReason).toBe("invalid_model_output");
    expect(forged.state.plan?.steps[0]?.status).not.toBe("completed");
  });

  it("folds an unknown tool into an observation so the model can recover", async () => {
    const cwd = await tempDir();
    const driver = new FakeModelDriver([
      turnWithTools({ callId: "call-1", name: "missing_tool", argumentsJson: "{}" }),
      textTurn("改用已有工具后完成", "response-2"),
    ]);
    const unknownObservation = JSON.stringify({
      ok: false,
      error: "unknown_tool",
      message: "unknown tool: missing_tool",
    });
    const planner = new ScriptedPlanner(makeDraft({}), [
      completeWith([unknownObservation], ["criterion-1"]),
    ]);

    const result = await runAgentLoop(
      "任务",
      base(cwd, { model: driver, planner, tools: createRegistry(echoTool) }),
    );

    expect(result.stopReason).toBe("final_answer");
    expect(result.state.contextSources[0]?.content).toContain("unknown_tool");
  });

  it("stops as blocked_plan when no remaining step is dependency-ready", async () => {
    const cwd = await tempDir();
    const planner = new ScriptedPlanner(makeDraft({}));
    const blockedState = {
      ...createInitialState("任务", cwd, { maxSteps: 2, maxToolCalls: 2 }),
      plan: makeTaskPlan({
        steps: [planStep("a", { status: "in_progress" }), planStep("b", { dependsOn: ["a"] })],
      }),
    };

    const result = await runAgentLoopFromState(
      blockedState,
      base(cwd, {
        model: new FakeModelDriver([]),
        planner,
        tools: createRegistry(echoTool),
      }),
    );

    expect(result.stopReason).toBe("blocked_plan");
    expect(result.status).toBe("blocked");
    expect(result.state.budget.modelSteps).toBe(0);
  });

  it("records a plan_blocked event naming the step with unmet dependencies", async () => {
    const cwd = await tempDir();
    const state = {
      ...createInitialState("任务", cwd, { maxSteps: 2, maxToolCalls: 2 }),
      plan: makeTaskPlan({
        steps: [
          // 有一个 in_progress 步骤，`shouldReplan` 才不会先走修订分支。
          planStep("active-step", { status: "in_progress" }),
          planStep("blocked-step", { status: "blocked", dependsOn: ["active-step"] }),
          planStep("step-2", { dependsOn: ["blocked-step"] }),
        ],
      }),
    };

    const result = await runAgentLoopFromState(
      state,
      base(cwd, {
        model: new FakeModelDriver([]),
        planner: new ScriptedPlanner(makeDraft({})),
        tools: createRegistry(echoTool),
      }),
    );

    expect(result.stopReason).toBe("blocked_plan");
    const recorded = result.state.events.filter((event) => event.type === "plan_blocked");
    expect(recorded).toHaveLength(1);

    const detail = parseDetail(recorded[0]?.detail ?? "");
    expect(detail["reason"]).toBe("no_ready_step");
    expect(String(detail["summary"])).toContain("没有依赖就绪");

    const pending = pendingStepOf(detail, "step-2");
    expect(pending["status"]).toBe("pending");
    expect(pending["unmetDependencies"]).toEqual(["blocked-step"]);

    const steps = detail["pendingSteps"];
    expect(Array.isArray(steps) ? steps.length : 0).toBeLessThanOrEqual(10);
  });

  it("emits plan_revised and bumps the plan version", async () => {
    const cwd = await tempDir();
    const draft = makeDraft({ steps: [{ id: "inspect", title: "读取 package.json" }] });
    const planner = new ScriptedPlanner(
      draft,
      [
        {
          completed: false,
          evidence: [echoObservation],
          passedCriteria: [],
          replanReason: "failed_assumption",
        },
      ],
      draft,
    );
    const events: string[] = [];
    const result = await runAgentLoop(
      "任务",
      base(cwd, {
        maxSteps: 2,
        model: new FakeModelDriver([turnWithTools(echoCall), textTurn("仍然未完成", "response-2")]),
        planner,
        tools: createRegistry(echoTool),
        onEvent: (event) => void events.push(event.type),
      }),
    );

    expect(events).toContain("plan_revised");
    expect(planner.revisions[0]?.reason).toBe("failed_assumption");
    expect(result.state.plan?.version).toBe(2);
    expect(result.state.planHistory[0]).toMatchObject({ version: 2 });
    expect(result.stopReason).toBe("max_steps");
  });

  it("waits for user input instead of completing", async () => {
    const cwd = await tempDir();
    const driver = new FakeModelDriver([
      {
        responseId: "response-1",
        finalText: "",
        toolCalls: [],
        userInputRequest: {
          id: "request-1",
          kind: "clarification",
          question: "--name 未提供时使用哪个默认值？",
          reason: "缺少关键产品选择",
          createdAt: "2024-01-01T00:00:00.000Z",
        },
      },
    ]);

    const result = await runAgentLoop(
      "任务",
      base(cwd, {
        model: driver,
        planner: new ScriptedPlanner(makeDraft({})),
        tools: createRegistry(echoTool),
      }),
    );

    expect(result.stopReason).toBe("user_input_required");
    expect(result.status).toBe("waiting");
    expect(result.state.pendingUserInput?.id).toBe("request-1");
    expect(result.state.events.map((event) => event.type)).toContain("user_input_requested");
  });

  it("rejects a turn that mixes a user request with side-effecting tool calls", async () => {
    const cwd = await tempDir();
    const driver = new FakeModelDriver([
      {
        responseId: "response-1",
        finalText: "",
        toolCalls: [echoCall],
        userInputRequest: {
          id: "request-1",
          kind: "clarification",
          question: "问题？",
          reason: "理由",
          createdAt: "2024-01-01T00:00:00.000Z",
        },
      },
    ]);

    const result = await runAgentLoop(
      "任务",
      base(cwd, {
        model: driver,
        planner: new ScriptedPlanner(makeDraft({})),
        tools: createRegistry(echoTool),
      }),
    );

    expect(result.stopReason).toBe("invalid_model_output");
    expect(result.state.budget.toolCalls).toBe(0);
  });
});

describe("agent loop completion gate and approvals", () => {
  it("blocks completion until a current-revision validation exists, then allows it", async () => {
    const cwd = await tempDir();
    const registry = createRegistry(applyPatchTool, readFileTool, runCommandTool);
    const policy: PolicyContext = {
      cwd,
      realWorkspaceRoot: cwd,
      allowedArgv: [["node", "-e", "process.exit(0)"]],
      network: "disabled",
    };
    const approvals = new InMemoryApprovalLedger();
    const specs: ValidationSpec[] = [
      { command: "node", args: ["-e", "process.exit(0)"], criterionIds: ["criterion-1"] },
    ];
    const draft = makeDraft({
      criteria: [{ id: "criterion-1", description: "补丁产生且验证通过" }],
      steps: [{ id: "implement", title: "写入文件并验证" }],
    });

    const patchObservation = JSON.stringify({
      ok: true,
      data: {
        operation: "create",
        path: "README.md",
        sha256: sha256("# Hello Agent\n"),
      },
    });

    // 第一段：写入成功，但验证命令需要人工批准，Step 先不算完成。
    const firstPlanner = new ScriptedPlanner(draft, [notCompleted([patchObservation])]);
    const firstDriver = new FakeModelDriver([
      turnWithTools({
        callId: "call-patch",
        name: "apply_patch",
        argumentsJson: JSON.stringify({
          operation: "create",
          path: "README.md",
          content: "# Hello Agent\n",
        }),
      }),
      turnWithTools({
        callId: "call-run",
        name: "run_command",
        argumentsJson: JSON.stringify({ command: "node", args: ["-e", "process.exit(0)"] }),
      }),
    ]);

    const first = await runAgentLoop(
      "写入 README 并验证",
      base(cwd, {
        model: firstDriver,
        planner: firstPlanner,
        tools: registry,
        policy,
        approvals,
        validationSpecs: specs,
      }),
    );

    expect(first.stopReason).toBe("approval_required");
    expect(first.state.changedFiles).toEqual(["README.md"]);
    expect(first.state.mutationRevision).toBe(1);
    expect(first.state.validations).toHaveLength(0);

    const pending = await approvals.pendingRequests(first.state.runId);
    const request = pending[0];
    if (!request) throw new Error("approval request missing");
    await approvals.approve(first.state.runId, request.id);

    // 第二段：批准后同一 run 继续，验证命令成为当前 revision 的证据。
    const secondPlanner = new CompletingPlanner(draft, ["criterion-1"]);
    const secondDriver = new FakeModelDriver([
      turnWithTools({
        callId: "call-run-2",
        name: "run_command",
        argumentsJson: JSON.stringify({ command: "node", args: ["-e", "process.exit(0)"] }),
      }),
      textTurn("README 已更新并验证通过。", "response-final"),
    ]);

    const resumedState = transitionState(first.state, "running", "approval_granted");
    const second = await runAgentLoopFromState(
      resumedState,
      base(cwd, {
        model: secondDriver,
        planner: secondPlanner,
        tools: registry,
        policy,
        approvals,
        validationSpecs: specs,
      }),
    );

    expect(second.stopReason).toBe("final_answer");
    expect(second.state.validations).toHaveLength(1);
    expect(second.state.validations[0]).toMatchObject({
      status: "passed",
      validatedRevision: 1,
      criterionIds: ["criterion-1"],
    });
  });

  it("keeps budget counters when continuing from an existing state", async () => {
    const cwd = await tempDir();
    const driver = new FakeModelDriver([textTurn("done", "response-1")]);
    const planner = new ScriptedPlanner(makeDraft({}), []);
    const start = await runAgentLoop(
      "任务",
      base(cwd, {
        maxSteps: 5,
        maxToolCalls: 5,
        model: new FakeModelDriver([]),
        planner,
        tools: createRegistry(echoTool),
      }),
    );
    const consumed = {
      ...start.state,
      status: "running" as const,
      budget: { ...start.state.budget, modelSteps: 4, toolCalls: 3 },
      plan: makeTaskPlan({
        acceptanceCriteria: [criterion("criterion-1", "passed")],
        steps: [planStep("step-1", { status: "completed", evidence: ["evidence"] })],
      }),
    };

    const result = await runAgentLoopFromState(
      consumed,
      base(cwd, {
        maxSteps: 99,
        maxToolCalls: 99,
        model: driver,
        planner,
        tools: createRegistry(echoTool),
      }),
    );

    // 预算上限与已消费计数都来自 state.budget，因此恢复不会清零也不会放宽。
    expect(result.stopReason).toBe("final_answer");
    expect(result.state.budget.modelSteps).toBe(5);
    expect(result.state.budget.toolCalls).toBe(3);
    expect(result.state.budget.maxSteps).toBe(5);
  });
});

describe("agent loop trace", () => {
  it("records loop events with outcomes and monotonic sequences", async () => {
    const cwd = await tempDir();
    const trace = new InMemoryTraceSink();
    const state = {
      ...createInitialState("任务", cwd, { maxSteps: 3, maxToolCalls: 3 }),
      plan: makeTaskPlan({
        goal: "任务",
        acceptanceCriteria: [criterion("criterion-1", "passed")],
        steps: [planStep("step-1", { status: "completed", evidence: ["evidence"] })],
      }),
    };

    const result = await runAgentLoopFromState(
      state,
      base(cwd, {
        model: new FakeModelDriver([textTurn("done", "response-1")]),
        planner: new ScriptedPlanner(makeDraft({})),
        tools: createRegistry(echoTool),
        trace,
      }),
    );

    expect(result.stopReason).toBe("final_answer");
    const recorded = trace.readRun(result.state.runId);
    expect(recorded.map((event) => event.type)).toEqual([
      "run_started",
      "model_started",
      "model_completed",
      "run_stopped",
    ]);
    expect(recorded.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(recorded.at(-1)?.outcome).toBe("passed");
  });

  it("marks a blocked stop as blocked in the trace sink", async () => {
    const cwd = await tempDir();
    const trace = new InMemoryTraceSink();
    const state = {
      ...createInitialState("任务", cwd, { maxSteps: 2, maxToolCalls: 2 }),
      plan: makeTaskPlan({
        goal: "任务",
        steps: [planStep("a", { status: "in_progress" }), planStep("b", { dependsOn: ["a"] })],
      }),
    };

    const result = await runAgentLoopFromState(
      state,
      base(cwd, {
        model: new FakeModelDriver([]),
        planner: new ScriptedPlanner(makeDraft({})),
        tools: createRegistry(echoTool),
        trace,
      }),
    );

    expect(result.stopReason).toBe("blocked_plan");
    const stop = trace.readRun(result.state.runId).at(-1);
    expect(stop).toMatchObject({ type: "run_stopped", outcome: "blocked" });
  });
});
