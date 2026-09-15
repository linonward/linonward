import { describe, expect, it } from "vitest";

import { parseRunSnapshot } from "../src/lib/snapshot.js";

/** `GET /api/runs/:runId` 的真实返回形状（字段名与 `AgentState` 一致）。 */
function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: "run-1",
    task: "读取 package.json 并总结",
    savedAt: "2024-01-01T00:00:05.000Z",
    status: "waiting",
    stopReason: "approval_required",
    budget: { maxSteps: 6, maxToolCalls: 12, modelSteps: 1, toolCalls: 1 },
    usage: {
      inputTokens: 1262,
      outputTokens: 64,
      cachedInputTokens: 1024,
      modelCalls: 1,
      toolCalls: 1,
      wallMs: 3_000,
      estimatedCostUsd: 0.000613,
    },
    changedFiles: ["a.txt"],
    validations: [],
    plan: { goal: "读取 package.json 并总结" },
    messages: [{ role: "user", content: "任务" }],
    pending: {
      requestId: "req-1",
      question: "是否允许执行 run_command？",
      reason: "策略要求人工批准",
    },
    ...overrides,
  };
}

describe("parseRunSnapshot", () => {
  it("解析 checkpoint 快照的展示字段", () => {
    const view = parseRunSnapshot(payload());

    expect(view).toEqual({
      runId: "run-1",
      task: "读取 package.json 并总结",
      savedAt: "2024-01-01T00:00:05.000Z",
      status: "waiting",
      stopReason: "approval_required",
      budget: { maxSteps: 6, maxToolCalls: 12, modelSteps: 1, toolCalls: 1 },
      usage: {
        inputTokens: 1262,
        outputTokens: 64,
        cachedInputTokens: 1024,
        modelCalls: 1,
        toolCalls: 1,
        wallMs: 3_000,
        costUsd: 0.000613,
      },
      changedFiles: ["a.txt"],
      plan: { goal: "读取 package.json 并总结" },
      pending: {
        requestId: "req-1",
        question: "是否允许执行 run_command？",
        reason: "策略要求人工批准",
      },
    });
  });

  it("缺字段就是缺字段：不用 0 / 空串冒充", () => {
    const view = parseRunSnapshot({ runId: "run-2", status: "completed" });

    expect(view).toBeDefined();
    expect(view?.runId).toBe("run-2");
    expect(view?.task).toBeUndefined();
    expect(view?.usage).toBeUndefined();
    expect(view?.pending).toBeUndefined();
    expect(view?.budget).toEqual({});
    expect(view?.changedFiles).toEqual([]);
  });

  it("不是对象、缺 runId、或 pending 不完整时拒绝/降级", () => {
    expect(parseRunSnapshot(undefined)).toBeUndefined();
    expect(parseRunSnapshot("nope")).toBeUndefined();
    expect(parseRunSnapshot({ status: "completed" })).toBeUndefined();
    // pending 缺 requestId 时不能渲染出无法提交的表单。
    expect(parseRunSnapshot(payload({ pending: { reason: "只有原因" } }))?.pending).toBeUndefined();
  });

  it("usage 只有部分字段时只保留能确认的部分（成本缺失即 unknown）", () => {
    const view = parseRunSnapshot(payload({ usage: { inputTokens: 10 } }));

    expect(view?.usage).toEqual({ inputTokens: 10 });
    expect(view?.usage?.costUsd).toBeUndefined();
  });
});
