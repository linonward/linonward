import { describe, expect, it } from "vitest";

import {
  deriveStopHint,
  type JournalRecord,
  pendingQuestion,
  projectRun,
} from "../src/lib/journal.js";

/** 一条最小但完整的运行记录序列：两轮模型调用 + 工具结果 + 运行汇总。 */
function records(): JournalRecord[] {
  return [
    {
      kind: "run_started",
      at: "2024-01-01T00:00:00.000Z",
      command: "run",
      task: "读取 package.json",
      cwd: "/workspace",
      budgets: { maxSteps: 4, maxToolCalls: 8 },
      allowedArgv: [["node", "--version"]],
      requireSandbox: false,
      modelId: "deepseek-v4-flash",
    },
    {
      kind: "model_request",
      at: "2024-01-01T00:00:00.100Z",
      step: 1,
      phase: "start",
      instructions: "SYSTEM PROMPT",
      input: [{ role: "user", content: "读取 package.json" }],
      outputs: [],
      toolNames: ["read_file"],
    },
    {
      kind: "model_response",
      at: "2024-01-01T00:00:01.100Z",
      step: 1,
      phase: "start",
      responseId: "response-1",
      finalText: "",
      reasoning: ["先看看 package.json。", "再决定下一步。"],
      toolCalls: [{ callId: "call-1", name: "read_file", argumentsJson: '{"path":"a"}' }],
      durationMs: 1_000,
    },
    {
      kind: "usage",
      scope: "model",
      at: "2024-01-01T00:00:01.100Z",
      step: 1,
      phase: "start",
      model: "deepseek-v4-flash",
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 40,
      durationMs: 1_000,
      costUsd: 0.0001,
    },
    {
      kind: "tool_call",
      at: "2024-01-01T00:00:01.200Z",
      callId: "call-1",
      name: "read_file",
      argumentsJson: '{"path":"a"}',
      durationMs: 3,
    },
    {
      kind: "tool_result",
      at: "2024-01-01T00:00:01.300Z",
      callId: "call-1",
      name: "read_file",
      durationMs: 3,
      ok: true,
      effect: "read",
      output: '{"ok":true,"data":{"name":"a"}}',
      policy: { type: "allow", scope: "read:read_file" },
    },
    {
      kind: "model_request",
      at: "2024-01-01T00:00:01.400Z",
      step: 2,
      phase: "continue",
      instructions: "SYSTEM PROMPT",
      input: [{ role: "user", content: "读取 package.json" }],
      outputs: [{ callId: "call-1", output: '{"ok":true}' }],
      toolNames: ["read_file"],
    },
    {
      kind: "model_response",
      at: "2024-01-01T00:00:02.400Z",
      step: 2,
      phase: "continue",
      responseId: "response-2",
      finalText: "package.json 名字是 a。",
      toolCalls: [],
      durationMs: 1_000,
    },
    {
      kind: "usage",
      scope: "model",
      at: "2024-01-01T00:00:02.400Z",
      step: 2,
      phase: "continue",
      model: "deepseek-v4-flash",
      inputTokens: 200,
      outputTokens: 30,
      durationMs: 1_000,
    },
    {
      kind: "usage",
      scope: "run",
      at: "2024-01-01T00:00:03.000Z",
      modelCalls: 2,
      toolCalls: 1,
      inputTokens: 300,
      outputTokens: 50,
      cachedInputTokens: 40,
      wallMs: 3_000,
      prices: { asOf: "2024-01-01", source: "deepseek" },
      costBasis: "默认口径",
    },
    {
      kind: "run_stopped",
      at: "2024-01-01T00:00:03.000Z",
      status: "completed",
      stopReason: "final_answer",
    },
  ];
}

describe("projectRun", () => {
  it("按轮次分组模型请求 / 响应 / 工具结果", () => {
    const view = projectRun("run-1", records());

    expect(view.runId).toBe("run-1");
    expect(view.start?.cwd).toBe("/workspace");
    expect(view.start?.modelId).toBe("deepseek-v4-flash");
    expect(view.rounds.map((round) => round.step)).toEqual([1, 2]);
    expect(view.rounds.map((round) => round.phase)).toEqual(["start", "continue"]);

    const first = view.rounds[0];
    expect(first?.request?.instructions).toBe("SYSTEM PROMPT");
    expect(first?.request?.input).toEqual([{ role: "user", content: "读取 package.json" }]);
    expect(first?.reasoning).toEqual(["先看看 package.json。", "再决定下一步。"]);
    expect(first?.toolCalls).toHaveLength(1);
    expect(first?.toolCalls[0]?.result?.ok).toBe(true);
    expect(first?.toolCalls[0]?.result?.output).toBe('{"ok":true,"data":{"name":"a"}}');
    expect(first?.toolCalls[0]?.result?.policy).toEqual({ type: "allow", scope: "read:read_file" });
    expect(first?.durationMs).toBe(1_000);

    // 第二轮没有 reasoning：缺失就是 undefined，不用空数组冒充。
    expect(view.rounds[1]?.reasoning).toBeUndefined();
    expect(view.rounds[1]?.finalText).toBe("package.json 名字是 a。");
    expect(view.rounds[1]?.request?.outputs).toEqual([{ callId: "call-1", output: '{"ok":true}' }]);
    expect(view.done).toBe(true);
    expect(view.stop?.status).toBe("completed");
    expect(view.stop?.stopReason).toBe("final_answer");
  });

  it("优先采用运行汇总记录的用量与成本；成本缺失时明确标成 unknown", () => {
    const view = projectRun("run-1", records());

    expect(view.usage.source).toBe("run");
    expect(view.usage.modelCalls).toBe(2);
    expect(view.usage.toolCalls).toBe(1);
    expect(view.usage.inputTokens).toBe(300);
    expect(view.usage.outputTokens).toBe(50);
    expect(view.usage.cachedInputTokens).toBe(40);
    expect(view.usage.wallMs).toBe(3_000);
    expect(view.usage.costKnown).toBe(false);
    expect(view.usage.costUsd).toBeUndefined();
    expect(view.usage.prices).toEqual({ asOf: "2024-01-01", source: "deepseek" });
  });

  it("没有运行汇总记录时按次累加，且任一次缺成本就不报成本", () => {
    const withoutRunUsage = records().filter(
      (record) => record["kind"] !== "usage" || record["scope"] !== "run",
    );
    const view = projectRun("run-1", withoutRunUsage);

    expect(view.usage.source).toBe("sum");
    expect(view.usage.modelCalls).toBe(2);
    expect(view.usage.inputTokens).toBe(300);
    expect(view.usage.cachedInputTokens).toBe(40);
    // 第二次调用没有 costUsd，因此整体不能给一个"部分求和"的成本。
    expect(view.usage.costKnown).toBe(false);
    expect(view.usage.costUsd).toBeUndefined();
    // 墙钟从第一条到最后一记录的 at 推算。
    expect(view.usage.wallMs).toBe(3_000);
  });

  it("预算进度来自 run_started，并在预算耗尽后改用事件 detail", () => {
    const view = projectRun("run-1", records());
    expect(view.budget).toEqual({
      modelSteps: 2,
      maxSteps: 4,
      toolCalls: 1,
      maxToolCalls: 8,
    });

    const exhausted = projectRun("run-2", [
      ...records(),
      {
        kind: "budget_exhausted",
        at: "2024-01-01T00:00:03.100Z",
        type: "budget_exhausted",
        reason: "max_steps",
        budget: { modelSteps: 4, maxSteps: 4, toolCalls: 2, maxToolCalls: 8 },
        usage: { modelCalls: 4, toolCalls: 2, durationMs: 10, cost: "unknown" },
        pendingSteps: [{ id: "step-1", status: "pending", dependsOn: [], unmetDependencies: [] }],
        pendingStepsOmitted: 0,
        recentToolCalls: [],
        recentToolCallsOmitted: 0,
      },
      {
        kind: "run_stopped",
        at: "2024-01-01T00:00:03.200Z",
        status: "failed",
        stopReason: "max_steps",
      },
    ]);

    expect(exhausted.budget.modelSteps).toBe(4);
    expect(exhausted.stop?.detailKind).toBe("budget_exhausted");
    expect(exhausted.stop?.stopReason).toBe("max_steps");
    expect(exhausted.stop?.hint).toContain("reason=max_steps");
    expect(exhausted.stop?.hint).toContain("pending=1");
  });

  it("计划变化与原始日志各自成组", () => {
    const view = projectRun("run-1", [
      ...records(),
      {
        kind: "plan_revised",
        at: "2024-01-01T00:00:02.000Z",
        version: 2,
        reason: "第一次修订",
        detail: { type: "plan_revised", addedSteps: ["step-2"], removedSteps: [] },
      },
      { kind: "log_line", at: "2024-01-01T00:00:00.000Z", text: '{"type":"run_started"}' },
    ]);

    expect(view.planChanges).toHaveLength(1);
    expect(view.planChanges[0]?.version).toBe(2);
    expect(view.planChanges[0]?.reason).toBe("第一次修订");
    expect(view.planChanges[0]?.detail).toEqual({
      type: "plan_revised",
      addedSteps: ["step-2"],
      removedSteps: [],
    });
    expect(view.logLines).toEqual(['{"type":"run_started"}']);
  });

  it("等待审批的请求可以从工具结果里读出来（用于回答框）", () => {
    const view = projectRun("run-1", [
      {
        kind: "model_response",
        step: 1,
        phase: "start",
        responseId: "response-1",
        finalText: "",
        toolCalls: [{ callId: "call-1", name: "run_command", argumentsJson: "{}" }],
        durationMs: 1,
      },
      {
        kind: "tool_result",
        callId: "call-1",
        name: "run_command",
        durationMs: 1,
        waiting: { requestId: "req-1", reason: "需要批准" },
      },
    ]);

    expect(pendingQuestion(view)).toEqual({ requestId: "req-1", reason: "需要批准" });
  });
});

describe("deriveStopHint", () => {
  it("plan_blocked 直接用 summary 与 reason", () => {
    expect(
      deriveStopHint({ type: "plan_blocked", reason: "no_ready_step", summary: "没有就绪步骤" }),
    ).toBe("没有就绪步骤（reason=no_ready_step）");
  });

  it("未知 detail 返回 undefined，不猜", () => {
    expect(deriveStopHint({ type: "something_else" })).toBeUndefined();
  });
});

/** 硬上限要能在界面上看见：预算条之外，成本与墙钟各有一条"已用 / 上限"。 */
describe("预算视图里的硬上限", () => {
  it("从 run_started 的 budgets 读回 maxCostUsd / maxWallMs", () => {
    const records: JournalRecord[] = [
      {
        kind: "run_started",
        at: "2024-01-01T00:00:00.000Z",
        task: "任务",
        cwd: "/workspace",
        budgets: { maxSteps: 4, maxToolCalls: 8, maxCostUsd: 0.5, maxWallMs: 60_000 },
        allowedArgv: [],
        requireSandbox: false,
      },
      {
        kind: "usage",
        scope: "run",
        modelCalls: 1,
        toolCalls: 0,
        inputTokens: 10,
        outputTokens: 2,
        wallMs: 1_000,
        costUsd: 0.25,
      },
    ];

    const view = projectRun("run-1", records);

    expect(view.budget).toMatchObject({ maxCostUsd: 0.5, maxWallMs: 60_000 });
  });

  it("旧记录没有上限时视图里也不写这两个字段", () => {
    const view = projectRun("run-1", [
      {
        kind: "run_started",
        at: "2024-01-01T00:00:00.000Z",
        budgets: { maxSteps: 4, maxToolCalls: 8 },
        allowedArgv: [],
        requireSandbox: false,
      },
    ]);

    expect(Object.hasOwn(view.budget, "maxCostUsd")).toBe(false);
    expect(Object.hasOwn(view.budget, "maxWallMs")).toBe(false);
  });
});
