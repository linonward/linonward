import { describe, expect, it } from "vitest";

import { applyUserAnswer, applyUserSteering, waitForUserInput } from "../src/interaction.js";
import { InMemoryApprovalLedger, authorize, type PolicyContext } from "../src/policy.js";
import { createInitialState } from "../src/state.js";
import { runCommandTool } from "../src/tools/run-command.js";
import type { UserInputRequest } from "../src/types.js";
import { makeTaskPlan } from "./support.js";

const now = new Date("2024-02-01T00:00:00.000Z");

function request(overrides: Partial<UserInputRequest> = {}): UserInputRequest {
  return {
    id: "request-1",
    kind: "clarification",
    question: "--name 未提供时使用哪个默认值？",
    reason: "缺少关键产品选择",
    createdAt: now.toISOString(),
    ...overrides,
  };
}

describe("user interaction", () => {
  it("persists the question and event before waiting", () => {
    const initial = createInitialState("增加 --name", "/workspace", undefined, { now });
    const waiting = waitForUserInput(initial, request(), now);

    expect(waiting.status).toBe("waiting");
    expect(waiting.pendingUserInput?.id).toBe("request-1");
    expect(waiting.events.map((event) => event.type)).toEqual([
      "run_started",
      "user_input_requested",
      "status_changed",
    ]);
    expect(waiting.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
  });

  it("refuses a second pending request", () => {
    const waiting = waitForUserInput(createInitialState("任务", "/workspace"), request());

    expect(() => waitForUserInput(waiting, request({ id: "request-2" }))).toThrow(
      "user_input_already_pending",
    );
  });

  it("rejects unknown, empty and expired answers", () => {
    const waiting = waitForUserInput(createInitialState("任务", "/workspace"), request(), now);

    expect(() =>
      applyUserAnswer(
        waiting,
        { requestId: "other", content: "x", receivedAt: now.toISOString() },
        now,
      ),
    ).toThrow("unexpected_user_input");
    expect(() =>
      applyUserAnswer(
        waiting,
        { requestId: "request-1", content: "   ", receivedAt: now.toISOString() },
        now,
      ),
    ).toThrow("empty_user_input");

    const expiring = waitForUserInput(
      createInitialState("任务", "/workspace"),
      request({ expiresAt: "2023-12-31T00:00:00.000Z" }),
      now,
    );
    expect(() =>
      applyUserAnswer(
        expiring,
        { requestId: "request-1", content: "now", receivedAt: now.toISOString() },
        now,
      ),
    ).toThrow("expired_user_input");
  });

  it("resumes the same run with the answer attached as context", () => {
    const initial = createInitialState("增加 --name", "/workspace", {
      maxSteps: 7,
      maxToolCalls: 9,
    });
    const waiting = waitForUserInput(initial, request(), now);
    const resumed = applyUserAnswer(
      waiting,
      { requestId: "request-1", content: "默认使用当前用户名", receivedAt: now.toISOString() },
      now,
    );

    expect(resumed.status).toBe("running");
    expect(resumed.runId).toBe(initial.runId);
    expect(resumed.budget).toEqual({
      maxSteps: 7,
      maxToolCalls: 9,
      modelSteps: 0,
      toolCalls: 0,
    });
    expect(resumed.pendingUserInput).toBeUndefined();
    expect(resumed.contextSources).toHaveLength(1);
    expect(resumed.contextSources[0]).toMatchObject({
      id: "user-input:request-1",
      kind: "user_input",
      content: "默认使用当前用户名",
    });
    expect(resumed.events.at(-1)?.type).toBe("status_changed");
  });

  it("turns a new constraint into a plan revision request", () => {
    const state = { ...createInitialState("任务", "/workspace"), plan: makeTaskPlan() };
    const outcome = applyUserSteering(
      state,
      { kind: "constraint", constraint: "必须保持向后兼容" },
      now,
    );

    expect(outcome.replanReason).toBe("new_constraint");
    expect(outcome.invalidateApprovals).toBe(false);
    expect(outcome.state.constraints).toEqual(["必须保持向后兼容"]);
    expect(outcome.state.goalVersion).toBe(1);
  });

  it("bumps the goal version and invalidates stale approvals on a goal change", async () => {
    const state = { ...createInitialState("旧目标", "/workspace"), plan: makeTaskPlan() };
    const outcome = applyUserSteering(state, { kind: "goal_change", goal: "新目标" }, now);

    expect(outcome.invalidateApprovals).toBe(true);
    expect(outcome.state.task).toBe("新目标");
    expect(outcome.state.goalVersion).toBe(2);
    expect(outcome.state.plan?.version).toBe(2);
    expect(outcome.state.plan?.goal).toBe("新目标");
    expect(outcome.state.changedFiles).toEqual([]);

    const context: PolicyContext = {
      cwd: "/workspace",
      realWorkspaceRoot: "/workspace",
      allowedArgv: [["pnpm", "test"]],
      network: "disabled",
    };
    const decision = authorize(runCommandTool, { command: "pnpm", args: ["test"] }, context);
    if (decision.type !== "ask") throw new Error("expected an approval request");

    const ledger = new InMemoryApprovalLedger();
    await ledger.saveApprovalRequest("run-1", decision.request);
    await ledger.approve("run-1", decision.request.id, now);
    expect(
      await ledger.consumeApprovalGrant("run-1", decision.request.actionDigest, now),
    ).toBeDefined();

    // 一次性凭证消费后立即失效。
    expect(
      await ledger.consumeApprovalGrant("run-1", decision.request.actionDigest, now),
    ).toBeUndefined();

    await ledger.saveApprovalRequest("run-1", decision.request);
    await ledger.approve("run-1", decision.request.id, now);
    await ledger.invalidateRun("run-1");
    expect(
      await ledger.consumeApprovalGrant("run-1", decision.request.actionDigest, now),
    ).toBeUndefined();
  });

  it("propagates cancellation without losing the audit trail", () => {
    const state = createInitialState("任务", "/workspace");
    const outcome = applyUserSteering(state, { kind: "cancel", reason: "user_cancelled" }, now);

    expect(outcome.state.status).toBe("cancelled");
    expect(outcome.state.stopReason).toBe("user_cancelled");
    expect(outcome.state.events.map((event) => event.sequence)).toEqual([1, 2]);
  });
});
