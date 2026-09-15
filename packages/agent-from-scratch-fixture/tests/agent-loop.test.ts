import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  type AgentLoopEvent,
  type AgentLoopOptions,
  MAX_BUDGET_EXHAUSTED_EVIDENCE_CHARACTERS,
  MAX_BUDGET_EXHAUSTED_PENDING_STEPS,
  MAX_BUDGET_EXHAUSTED_RECENT_TOOL_CALLS,
  runAgentLoop,
  runAgentLoopFromState,
} from "../src/agent-loop.js";
import { isRecord, sha256 } from "../src/checkpoint.js";
import { fromDurableState, toDurableState } from "../src/durable-state.js";
import { FakeModelDriver, textTurn, turnWithTools, withUsage } from "../src/fake-model.js";
import { InMemoryApprovalLedger, type PolicyContext } from "../src/policy.js";
import { createInitialState, transitionState } from "../src/state.js";
import { defineTool } from "../src/tool.js";
import { applyPatchTool } from "../src/tools/apply-patch.js";
import { readFileTool } from "../src/tools/read-file.js";
import { runCommandTool } from "../src/tools/run-command.js";
import { InMemoryTraceSink } from "../src/trace.js";
import type { AgentState, ValidationSpec } from "../src/types.js";
import {
  CompletingPlanner,
  completeWith,
  createRegistry,
  criterion,
  echoTool,
  failingTool,
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
  if (overrides.pricing !== undefined) options.pricing = overrides.pricing;
  if (overrides.repeatGuard !== undefined) options.repeatGuard = overrides.repeatGuard;
  return options;
}

const echoObservation = JSON.stringify({ ok: true, data: { echoed: "hi" } });
const echoCall = { callId: "call-1", name: "echo", argumentsJson: '{"value":"hi"}' };
/** `boom` 抛错后的 observation 形状（见 `execute-tool.ts` 的失败分支）。 */
const failureObservation = JSON.stringify({
  ok: false,
  error: "tool_error",
  message: "tool exploded",
});

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

/** 断言 JSON 子对象存在，并返回它；缺失即抛错，避免测试里散落类型断言。 */
function objectField(detail: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = detail[key];
  if (!isRecord(value)) throw new Error(`${key} is not an object`);
  return value;
}

function arrayField(detail: Record<string, unknown>, key: string): unknown[] {
  const value = detail[key];
  if (!Array.isArray(value)) throw new Error(`${key} is not an array`);
  return value;
}

function recordAt(items: unknown[], index: number): Record<string, unknown> {
  const value = items[index];
  if (!isRecord(value)) throw new Error(`item ${index} is not an object`);
  return value;
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

  it("attaches the bounded plan diff and the failed-tool evidence to plan_revised", async () => {
    const cwd = await tempDir();
    const draft = makeDraft({ steps: [{ id: "inspect", title: "读取 package.json" }] });
    const revised = makeDraft({
      steps: [
        { id: "inspect", title: "读取并解释 package.json" },
        { id: "extra", title: "新增的步骤" },
      ],
    });
    const planner = new ScriptedPlanner(
      draft,
      [
        {
          completed: false,
          evidence: [failureObservation],
          passedCriteria: [],
          replanReason: "failed_assumption",
        },
      ],
      revised,
    );
    const events: AgentLoopEvent[] = [];

    await runAgentLoop(
      "任务",
      base(cwd, {
        maxSteps: 2,
        model: new FakeModelDriver([
          turnWithTools({ callId: "call-boom", name: "boom", argumentsJson: "{}" }),
          textTurn("仍然未完成", "response-2"),
        ]),
        planner,
        tools: createRegistry(failingTool),
        onEvent: (event) => void events.push(event),
      }),
    );

    const revisedEvent = events.find((event) => event.type === "plan_revised");
    if (revisedEvent?.type !== "plan_revised") throw new Error("plan_revised event is missing");

    // 改了什么：新增 step-extra、改名 inspect、依赖未变；为什么：reason。
    expect(revisedEvent.detail).toMatchObject({
      type: "plan_revised",
      reason: "failed_assumption",
      addedSteps: ["extra"],
      removedSteps: [],
      renamedSteps: ["inspect"],
      addedStepsOmitted: 0,
      removedStepsOmitted: 0,
      renamedStepsOmitted: 0,
      dependencyChanges: 0,
      // 触发证据：最近失败的工具 + error code。
      recentFailures: [{ name: "boom", errorCode: "tool_error" }],
      recentFailuresOmitted: 0,
    });
  });

  it("accumulates model tokens, cache hits and tool calls into state.usage", async () => {
    const cwd = await tempDir();
    const driver = new FakeModelDriver([
      withUsage(turnWithTools(echoCall), {
        inputTokens: 100,
        outputTokens: 10,
        cachedInputTokens: 40,
      }),
      withUsage(textTurn("完成"), {
        inputTokens: 200,
        outputTokens: 20,
        cachedInputTokens: 60,
      }),
    ]);
    const planner = new ScriptedPlanner(
      makeDraft({ steps: [{ id: "inspect", title: "读取 package.json" }] }),
      [completeWith([echoObservation], ["criterion-1"])],
    );

    const result = await runAgentLoop(
      "任务",
      base(cwd, { model: driver, planner, tools: createRegistry(echoTool) }),
    );

    expect(result.stopReason).toBe("final_answer");
    expect(result.state.usage.inputTokens).toBe(300);
    expect(result.state.usage.outputTokens).toBe(30);
    expect(result.state.usage.cachedInputTokens).toBe(100);
    expect(result.state.usage.modelCalls).toBe(2);
    expect(result.state.usage.toolCalls).toBe(1);
    expect(result.state.usage.durationMs).toBeGreaterThanOrEqual(0);
    // 没有接线定价时算不出成本：保持 undefined，输出层显示 `cost=unknown`。
    expect(result.state.usage.estimatedCostUsd).toBeUndefined();
  });

  it("records a model call without usage as unknown instead of zero", async () => {
    const cwd = await tempDir();
    const driver = new FakeModelDriver([
      withUsage(turnWithTools(echoCall), { inputTokens: 100, outputTokens: 10 }),
      textTurn("完成"),
    ]);
    const planner = new ScriptedPlanner(
      makeDraft({ steps: [{ id: "inspect", title: "读取 package.json" }] }),
      [completeWith([echoObservation], ["criterion-1"])],
    );

    const result = await runAgentLoop(
      "任务",
      base(cwd, { model: driver, planner, tools: createRegistry(echoTool) }),
    );

    // 未知会传播：第二次调用没报 usage，整轮 token 就是未知，而不是"等于第一次的值"。
    expect(result.state.usage.inputTokens).toBeUndefined();
    expect(result.state.usage.outputTokens).toBeUndefined();
    expect(result.state.usage.modelCalls).toBe(2);
  });

  it("estimates cost from the injected price table and leaves it unknown otherwise", async () => {
    const cwd = await tempDir();
    const turn = withUsage(textTurn("完成"), { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    const planner = new CompletingPlanner(makeDraft({}), ["criterion-1"]);
    const table = {
      asOf: "2024-01-01",
      models: {
        "test-model": {
          inputPerMillionUsd: 100,
          cachedInputPerMillionUsd: 10,
          outputPerMillionUsd: 200,
          asOf: "2024-01-01",
        },
      },
    };

    const priced = await runAgentLoop(
      "任务",
      base(cwd, {
        model: new FakeModelDriver([turn]),
        planner,
        tools: createRegistry(echoTool),
        pricing: { modelId: "test-model", table },
      }),
    );
    expect(priced.state.usage.estimatedCostUsd).toBeCloseTo(300, 10);

    const unpriced = await runAgentLoop(
      "任务",
      base(cwd, {
        model: new FakeModelDriver([turn]),
        planner,
        tools: createRegistry(echoTool),
        pricing: { modelId: "not-in-the-table", table },
      }),
    );
    expect(unpriced.state.usage.estimatedCostUsd).toBeUndefined();
  });

  it("keeps accumulating usage across a durable round trip", async () => {
    const cwd = await tempDir();
    const seed = createInitialState("任务", cwd, { maxSteps: 4, maxToolCalls: 4 });
    const seededState: AgentState = {
      ...seed,
      plan: makeTaskPlan({ steps: [planStep("inspect", { status: "in_progress" })] }),
      activeStepId: "inspect",
      usage: {
        inputTokens: 1_000,
        outputTokens: 100,
        cachedInputTokens: 400,
        modelCalls: 3,
        toolCalls: 2,
        durationMs: 500,
      },
    };

    const restored = fromDurableState(toDurableState(seededState));
    // 检查点往返后用量原样回来，且是深拷贝（不与快照共享累加器）。
    expect(restored.usage).toEqual(seededState.usage);
    expect(restored.usage).not.toBe(seededState.usage);

    const driver = new FakeModelDriver([
      withUsage(turnWithTools({ ...echoCall, callId: "call-9" }), {
        inputTokens: 300,
        outputTokens: 30,
        cachedInputTokens: 200,
      }),
      withUsage(textTurn("最终答案"), {
        inputTokens: 200,
        outputTokens: 20,
        cachedInputTokens: 100,
      }),
    ]);
    const planner = new ScriptedPlanner(makeDraft({}), [
      completeWith([echoObservation], ["criterion-1"]),
    ]);

    const result = await runAgentLoopFromState(
      restored,
      base(cwd, { model: driver, planner, tools: createRegistry(echoTool) }),
    );

    expect(result.stopReason).toBe("final_answer");
    // 续跑不是从 0 重新开始：1k/100/400 的底座 + 本轮两轮调用。
    expect(result.state.usage.inputTokens).toBe(1_500);
    expect(result.state.usage.outputTokens).toBe(150);
    expect(result.state.usage.cachedInputTokens).toBe(700);
    expect(result.state.usage.modelCalls).toBe(5);
    expect(result.state.usage.toolCalls).toBe(3);
    expect(result.state.usage.durationMs).toBeGreaterThanOrEqual(500);
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

/** 测试自带的价目表：让 `budget_exhausted.usage.cost` 是确定值。 */
const BUDGET_PRICE_TABLE = {
  asOf: "2024-01-01",
  models: {
    "test-model": {
      inputPerMillionUsd: 100,
      cachedInputPerMillionUsd: 10,
      outputPerMillionUsd: 200,
      asOf: "2024-01-01",
    },
  },
};

function budgetState(cwd: string, input: { maxSteps: number; maxToolCalls: number }): AgentState {
  return {
    ...createInitialState("任务", cwd, input),
    plan: makeTaskPlan({
      steps: [
        planStep("active-step", { status: "in_progress" }),
        planStep("blocked-step", { dependsOn: ["active-step"] }),
        planStep("pending-step"),
      ],
    }),
    activeStepId: "active-step",
  };
}

describe("预算耗尽的诊断", () => {
  it("max_steps 停止前登记有界的 budget_exhausted（pending / 工具调用 / 证据全部截断）", async () => {
    const cwd = await tempDir();
    const longEvidence = "e".repeat(MAX_BUDGET_EXHAUSTED_EVIDENCE_CHARACTERS + 300);
    const state: AgentState = {
      ...createInitialState("任务", cwd, { maxSteps: 1, maxToolCalls: 32 }),
      plan: makeTaskPlan({
        steps: [
          planStep("step-1", { status: "in_progress", completionEvidence: longEvidence }),
          planStep("step-2", { dependsOn: ["step-1"] }),
          ...Array.from({ length: 10 }, (_, index) => planStep(`step-${index + 3}`)),
        ],
      }),
      activeStepId: "step-1",
      planHistory: [
        { version: 2, reason: "failed_assumption", changedAt: "2024-01-01T00:00:00.000Z" },
      ],
    };
    const driver = new FakeModelDriver([
      withUsage(
        turnWithTools(
          { callId: "call-a1", name: "echo", argumentsJson: '{"value":"a"}' },
          { callId: "call-a2", name: "echo", argumentsJson: '{"value":"a"}' },
          { callId: "call-a3", name: "echo", argumentsJson: '{"value":"a"}' },
          { callId: "call-b", name: "echo", argumentsJson: '{"value":"b"}' },
          { callId: "call-c", name: "echo", argumentsJson: '{"value":"c"}' },
          { callId: "call-d", name: "echo", argumentsJson: '{"value":"d"}' },
        ),
        { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedInputTokens: 0 },
      ),
    ]);

    const result = await runAgentLoopFromState(
      state,
      base(cwd, {
        model: driver,
        planner: new ScriptedPlanner(makeDraft({}), [notCompleted()]),
        tools: createRegistry(echoTool),
        pricing: { modelId: "test-model", table: BUDGET_PRICE_TABLE },
      }),
    );

    expect(result.stopReason).toBe("max_steps");
    const recorded = result.state.events.filter((event) => event.type === "budget_exhausted");
    expect(recorded).toHaveLength(1);
    const detail = parseDetail(recorded[0]?.detail ?? "");

    expect(detail["type"]).toBe("budget_exhausted");
    expect(detail["reason"]).toBe("max_steps");
    expect(objectField(detail, "budget")).toEqual({
      modelSteps: 1,
      maxSteps: 1,
      toolCalls: 6,
      maxToolCalls: 32,
    });

    const usage = objectField(detail, "usage");
    expect(usage["modelCalls"]).toBe(1);
    expect(usage["toolCalls"]).toBe(6);
    expect(usage["inputTokens"]).toBe(1_000_000);
    expect(usage["outputTokens"]).toBe(1_000_000);
    // `estimateCostUsd` + `formatCostUsd`：1M * $100/M + 1M * $200/M = $300。
    expect(usage["cost"]).toBe("$300.000000");

    // 活动步骤：状态 + 依赖 + 有界的完成证据。
    expect(detail["activeStepId"]).toBe("step-1");
    const activeStep = objectField(detail, "activeStep");
    expect(activeStep["status"]).toBe("in_progress");
    expect(activeStep["dependsOn"]).toEqual([]);
    expect(String(activeStep["completionEvidence"]).length).toBeLessThanOrEqual(
      MAX_BUDGET_EXHAUSTED_EVIDENCE_CHARACTERS,
    );

    // 未完成步骤与 `plan_blocked` 同形状，且条数有界。
    const pendingSteps = arrayField(detail, "pendingSteps");
    expect(pendingSteps).toHaveLength(MAX_BUDGET_EXHAUSTED_PENDING_STEPS);
    expect(detail["pendingStepsOmitted"]).toBe(2);
    expect(recordAt(pendingSteps, 0)["unmetDependencies"]).toEqual([]);
    expect(recordAt(pendingSteps, 1)["unmetDependencies"]).toEqual(["step-1"]);

    // 最近工具调用有界，并标出"完全相同参数"的重复。
    const recent = arrayField(detail, "recentToolCalls");
    expect(recent).toHaveLength(MAX_BUDGET_EXHAUSTED_RECENT_TOOL_CALLS);
    expect(detail["recentToolCallsOmitted"]).toBe(1);
    expect(recordAt(recent, 0)["repeated"]).toBe(true);
    expect(recordAt(recent, 1)).toMatchObject({
      name: "echo",
      ok: false,
      errorCode: "repeated_tool_call",
      repeated: true,
    });

    expect(detail["lastReplanReason"]).toBe("failed_assumption");
  });

  it("max_tool_calls 停止前同样登记 budget_exhausted", async () => {
    const cwd = await tempDir();
    const driver = new FakeModelDriver([
      turnWithTools(
        { callId: "call-1", name: "echo", argumentsJson: '{"value":"a"}' },
        { callId: "call-2", name: "echo", argumentsJson: '{"value":"b"}' },
      ),
      turnWithTools({ callId: "call-3", name: "echo", argumentsJson: '{"value":"c"}' }),
    ]);

    const result = await runAgentLoopFromState(
      budgetState(cwd, { maxSteps: 8, maxToolCalls: 2 }),
      base(cwd, {
        model: driver,
        planner: new ScriptedPlanner(makeDraft({}), [notCompleted()]),
        tools: createRegistry(echoTool),
      }),
    );

    expect(result.stopReason).toBe("max_tool_calls");
    const recorded = result.state.events.filter((event) => event.type === "budget_exhausted");
    expect(recorded).toHaveLength(1);
    const detail = parseDetail(recorded[0]?.detail ?? "");

    expect(detail["reason"]).toBe("max_tool_calls");
    expect(objectField(detail, "budget")).toEqual({
      modelSteps: 2,
      maxSteps: 8,
      toolCalls: 2,
      maxToolCalls: 2,
    });
    // 没有接线定价时成本是 unknown，绝不是 $0.000000。
    expect(objectField(detail, "usage")["cost"]).toBe("unknown");
    // 这一轮的工具还没有执行：最近调用只有上一批的两条。
    expect(arrayField(detail, "recentToolCalls")).toHaveLength(2);
    expect(detail["activeStepId"]).toBe("active-step");
    expect(detail["pendingStepsOmitted"]).toBe(0);
  });
});

describe("重复工具调用守卫", () => {
  /** 计数工具：测试用它断言第 3 次完全相同的调用真的没有执行。 */
  function countingEchoTool() {
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
    return { executed, tool };
  }

  function identicalTurns(values: string[]): FakeModelDriver {
    return new FakeModelDriver(
      values.map((value, index) =>
        turnWithTools({
          callId: `call-${index + 1}`,
          name: "count_echo",
          argumentsJson: JSON.stringify({ value }),
        }),
      ),
    );
  }

  it("连续 3 次完全相同的调用：第 3 次不执行，只回 repeated_tool_call", async () => {
    const cwd = await tempDir();
    const { executed, tool } = countingEchoTool();
    const result = await runAgentLoop(
      "任务",
      base(cwd, {
        maxSteps: 3,
        model: identicalTurns(["same", "same", "same"]),
        planner: new ScriptedPlanner(makeDraft({}), [
          notCompleted(),
          notCompleted(),
          notCompleted(),
        ]),
        tools: createRegistry(tool),
      }),
    );

    expect(executed).toEqual(["same", "same"]);
    expect(result.stopReason).toBe("max_steps");
    expect(result.state.budget.toolCalls).toBe(3);

    const observations = result.state.contextSources.filter(
      (source) => source.kind === "tool_observation",
    );
    expect(observations).toHaveLength(3);
    expect(observations.at(-1)?.content).toContain('"error":"repeated_tool_call"');
    expect(result.state.failedAttempts).toContain("count_echo: repeated_tool_call");
    // 第 2 次重复时先给一条明确的 harness_feedback，而不是沉默。
    const feedback = result.state.contextSources.filter(
      (source) => source.kind === "harness_feedback",
    );
    expect(feedback).toHaveLength(1);
    expect(feedback[0]?.content).toContain("完全相同的参数");
    expect(feedback[0]?.priority).toBe(100);
  });

  it("同名但参数不同的连续调用不受影响：3 次都执行", async () => {
    const cwd = await tempDir();
    const { executed, tool } = countingEchoTool();
    const result = await runAgentLoop(
      "任务",
      base(cwd, {
        maxSteps: 3,
        model: identicalTurns(["one", "two", "three"]),
        planner: new ScriptedPlanner(makeDraft({}), [
          notCompleted(),
          notCompleted(),
          notCompleted(),
        ]),
        tools: createRegistry(tool),
      }),
    );

    expect(executed).toEqual(["one", "two", "three"]);
    expect(result.stopReason).toBe("max_steps");
  });

  it("repeatGuard:false 回到旧行为：完全相同的调用照常执行", async () => {
    const cwd = await tempDir();
    const { executed, tool } = countingEchoTool();
    const result = await runAgentLoop(
      "任务",
      base(cwd, {
        maxSteps: 3,
        repeatGuard: false,
        model: identicalTurns(["same", "same", "same"]),
        planner: new ScriptedPlanner(makeDraft({}), [
          notCompleted(),
          notCompleted(),
          notCompleted(),
        ]),
        tools: createRegistry(tool),
      }),
    );

    expect(executed).toEqual(["same", "same", "same"]);
    expect(result.state.budget.toolCalls).toBe(3);
    expect(
      result.state.contextSources.filter((source) => source.kind === "harness_feedback"),
    ).toHaveLength(0);
  });
});
