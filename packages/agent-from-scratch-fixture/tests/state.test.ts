import { describe, expect, it } from "vitest";

import {
  allowedTransitions,
  appendEvent,
  canTransition,
  createInitialState,
  transitionState,
} from "../src/state.js";

const fixedTime = new Date("2024-01-01T00:00:00.000Z");
const laterTime = new Date("2024-01-01T00:00:05.000Z");

describe("agent state machine", () => {
  it("records a waiting and resumed run without losing audit order", () => {
    const initial = createInitialState("检查 package.json", "/workspace", undefined, {
      now: fixedTime,
    });
    const waiting = transitionState(initial, "waiting", "approval_required", fixedTime);
    const resumed = transitionState(waiting, "running", "approval_granted", laterTime);

    expect(resumed.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(resumed.status).toBe("running");
    expect(resumed.stopReason).toBeUndefined();
    expect(resumed.events.every((event) => !Number.isNaN(Date.parse(event.recordedAt)))).toBe(true);
  });

  it("keeps the ledger and the budget across waiting and resume", () => {
    const initial = createInitialState("检查 package.json", "/workspace", {
      maxSteps: 3,
      maxToolCalls: 5,
    });
    const withWork = {
      ...initial,
      budget: { ...initial.budget, modelSteps: 2, toolCalls: 4 },
      mutationRevision: 2,
      validations: [
        {
          id: "validation-1",
          command: "pnpm",
          args: ["test"],
          exitCode: 0,
          durationMs: 12,
          status: "passed" as const,
          validatedRevision: 2,
          changedFileHashes: {},
          criterionIds: ["criterion-1"],
        },
      ],
    };

    const waiting = transitionState(withWork, "waiting", "user_input_required", fixedTime);
    const resumed = transitionState(waiting, "running", "user_input_received", laterTime);

    expect(resumed.budget).toEqual({ maxSteps: 3, maxToolCalls: 5, modelSteps: 2, toolCalls: 4 });
    expect(resumed.validations).toHaveLength(1);
    expect(resumed.mutationRevision).toBe(2);
  });

  it("rejects illegal and reason-less transitions", () => {
    const initial = createInitialState("任务", "/workspace");

    expect(() => transitionState(initial, "running", "noop")).toThrow(
      "invalid state transition: running -> running",
    );
    expect(() => transitionState(initial, "completed", "   ")).toThrow(
      "state transition requires a reason",
    );
    expect(canTransition("completed", "running")).toBe(false);
    expect(allowedTransitions.blocked).toEqual([]);
  });

  it("treats completed, failed and cancelled as terminal", () => {
    const initial = createInitialState("任务", "/workspace");

    for (const terminal of ["completed", "failed", "cancelled"] as const) {
      const stopped = transitionState(initial, terminal, terminal);
      expect(stopped.stopReason).toBe(terminal);
      expect(() => transitionState(stopped, "running", "resume")).toThrow(
        `invalid state transition: ${terminal} -> running`,
      );
    }
  });

  it("never reuses an event sequence after appendEvent", () => {
    const initial = createInitialState("任务", "/workspace", undefined, { now: fixedTime });
    const first = appendEvent(initial, "model_started", "1", fixedTime);
    const second = appendEvent(first, "model_completed", "1", laterTime);

    expect(second.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(second.nextEventSequence).toBe(4);
    expect(new Set(second.events.map((event) => event.eventId)).size).toBe(3);
  });

  it("reaches blocked from running and allows no direct recovery", () => {
    const initial = createInitialState("任务", "/workspace");
    const blocked = transitionState(initial, "blocked", "policy_denied");

    expect(blocked.status).toBe("blocked");
    expect(() => transitionState(blocked, "running", "retry")).toThrow(
      "invalid state transition: blocked -> running",
    );
  });
});

describe("预算里的硬上限", () => {
  it("只在显式设置时才写进 budget（缺省不限制，而不是 0）", () => {
    const plain = createInitialState("任务", "/workspace", { maxSteps: 4, maxToolCalls: 8 });
    expect(Object.hasOwn(plain.budget, "maxCostUsd")).toBe(false);
    expect(Object.hasOwn(plain.budget, "maxWallMs")).toBe(false);

    const capped = createInitialState("任务", "/workspace", {
      maxSteps: 4,
      maxToolCalls: 8,
      maxCostUsd: 0.25,
      maxWallMs: 60_000,
    });
    expect(capped.budget.maxCostUsd).toBe(0.25);
    expect(capped.budget.maxWallMs).toBe(60_000);
  });
});
