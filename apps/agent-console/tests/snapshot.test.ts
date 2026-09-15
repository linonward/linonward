import { describe, expect, it } from "vitest";

import { parseRunSnapshot, pendingExpired, snapshotNotice } from "../src/lib/snapshot.js";

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

describe("snapshotNotice：快照面板该说什么", () => {
  const base = {
    runId: "run-1",
    budget: {},
    changedFiles: [],
  };

  it("等待回答且频道还在：明确说可以提交", () => {
    const notice = snapshotNotice(
      { ...base, status: "waiting", pending: { requestId: "req-1", question: "", reason: "" } },
      false,
    );

    expect(notice).toContain("提交回答");
  });

  it("等待回答但频道没了：说清会从磁盘重建运行再继续", () => {
    const notice = snapshotNotice(
      { ...base, status: "waiting", pending: { requestId: "req-1", question: "", reason: "" } },
      true,
    );

    expect(notice).toContain("重建");
    expect(notice).toContain("凭证");
  });

  it("已经结束的运行不再说『实时流不可用』，而是说明时间线为什么重放不了", () => {
    const notice = snapshotNotice({ ...base, status: "completed" }, true);

    expect(notice).toContain("已经结束");
    expect(notice).not.toContain("无法继续");
    expect(notice).not.toContain("请重新发起");
  });

  it("检查点仍是 running 但频道没了：提示可能被打断，别假装还能继续", () => {
    const notice = snapshotNotice({ ...base, status: "running" }, true);

    expect(notice).toContain("running");
    expect(notice).toContain("重新发起");
  });

  it("过期与未过期按 expiresAt 判断；没有 expiresAt 的一律不算过期", () => {
    const now = Date.parse("2024-01-01T00:10:00.000Z");

    expect(
      pendingExpired(
        { requestId: "r", question: "", reason: "", expiresAt: "2024-01-01T00:15:00.000Z" },
        now,
      ),
    ).toBe(false);
    expect(
      pendingExpired(
        { requestId: "r", question: "", reason: "", expiresAt: "2024-01-01T00:05:00.000Z" },
        now,
      ),
    ).toBe(true);
    // 澄清请求没有 TTL，不能因为"读不出时间"就说过期。
    expect(pendingExpired({ requestId: "r", question: "", reason: "" }, now)).toBe(false);
    expect(pendingExpired(undefined, now)).toBe(false);
    // 时间戳本身不合法时交给服务端裁决。
    expect(
      pendingExpired({ requestId: "r", question: "", reason: "", expiresAt: "not-a-date" }, now),
    ).toBe(false);
  });

  it("过期的待答请求直接说明为什么提交没用", () => {
    const notice = snapshotNotice(
      {
        ...base,
        status: "waiting",
        pending: {
          requestId: "req-1",
          question: "",
          reason: "approval_required",
          expiresAt: "2020-01-01T00:00:00.000Z",
        },
      },
      true,
    );

    expect(notice).toContain("过期");
    expect(notice).toContain("重新发起");
  });

  it("频道还在且没有待答请求时不多说废话", () => {
    expect(snapshotNotice({ ...base, status: "completed" }, false)).toBeUndefined();
  });
});
