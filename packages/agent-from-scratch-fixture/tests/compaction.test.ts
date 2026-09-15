import { describe, expect, it } from "vitest";

import {
  buildCompactionSnapshot,
  compactionAsContextSources,
  isSafeCompactionBoundary,
  maybeCompactContext,
  projectCompactedContext,
  selectRawTailBoundary,
  shouldCompact,
  validateCompaction,
  type Compactor,
} from "../src/compaction.js";
import { createInitialState } from "../src/state.js";
import type { AgentEvent, AgentState, CompactionSnapshot } from "../src/types.js";
import { criterion, makeTaskPlan, planStep } from "./support.js";

type Draft = Omit<CompactionSnapshot, "id" | "createdAt" | "checksum">;

const now = new Date("2024-03-01T00:00:00.000Z");

function createFakeCompactor(overrides: Partial<Draft> = {}): Compactor {
  return {
    async compact(input) {
      return {
        sourceEventRange: { from: 0, to: 0 },
        goal: input.task,
        constraints: [],
        decisions: [],
        completedWork: input.plan.steps
          .filter((step) => step.status === "completed")
          .map((step) => ({ stepId: step.id, evidence: step.evidence })),
        pendingWork: input.plan.steps
          .filter((step) => step.status !== "completed")
          .map((step) => ({ stepId: step.id, reason: "尚未完成" })),
        acceptanceCriteria: input.plan.acceptanceCriteria,
        activeSkills: input.activeSkillNames,
        changedFiles: input.changedFiles,
        validationResults: [],
        unresolvedQuestions: [],
        failedAttempts: [],
        ...overrides,
      };
    },
  };
}

function createState(): AgentState {
  const state = createInitialState("压缩一次长运行", "/workspace", undefined, { now });
  state.plan = makeTaskPlan({
    goal: "压缩一次长运行",
    acceptanceCriteria: [criterion("criterion-1")],
    steps: [
      planStep("inspect", { status: "completed", evidence: ["read_file observation"] }),
      planStep("run-tests", { status: "pending" }),
    ],
  });
  state.changedFiles = ["src/index.ts"];
  state.changedFileHashes = { "src/index.ts": "hash-1" };
  state.mutationRevision = 1;
  return state;
}

function createEvents(count: number): AgentEvent[] {
  return Array.from({ length: count }, (_value, index) => ({
    eventId: `event-${index + 1}`,
    sequence: index + 1,
    recordedAt: now.toISOString(),
    type: `type_${index + 1}`,
    detail: `detail-${index + 1}`,
  }));
}

describe("compaction trigger and boundary", () => {
  it("only compacts above the conservative threshold", () => {
    expect(
      shouldCompact({
        estimatedInputTokens: 71_999,
        contextWindowTokens: 100_000,
        reservedOutputTokens: 10_000,
      }),
    ).toBe(false);
    expect(
      shouldCompact({
        estimatedInputTokens: 72_000,
        contextWindowTokens: 100_000,
        reservedOutputTokens: 10_000,
      }),
    ).toBe(true);
  });

  it("refuses to compact while a tool batch is still in flight", () => {
    expect(
      isSafeCompactionBoundary({
        status: "running",
        pendingToolCallCount: 0,
        pendingOutputCount: 0,
      }),
    ).toBe(true);
    expect(
      isSafeCompactionBoundary({
        status: "running",
        pendingToolCallCount: 1,
        pendingOutputCount: 0,
      }),
    ).toBe(false);
    expect(
      isSafeCompactionBoundary({
        status: "waiting",
        pendingToolCallCount: 0,
        pendingOutputCount: 0,
      }),
    ).toBe(false);
  });

  it("returns a reason instead of compacting below the threshold or at an unsafe boundary", async () => {
    const state = createState();
    const events = createEvents(5);
    const emitted: string[] = [];

    const below = await maybeCompactContext({
      state,
      events,
      usage: {
        estimatedInputTokens: 1_000,
        contextWindowTokens: 100_000,
        reservedOutputTokens: 10_000,
      },
      pendingToolCallCount: 0,
      pendingOutputCount: 0,
      compactor: createFakeCompactor(),
      emit: async (event) => void emitted.push(event.type),
    });
    expect(below).toMatchObject({ compacted: false, reason: "below_threshold" });

    const unsafe = await maybeCompactContext({
      state,
      events,
      usage: {
        estimatedInputTokens: 99_000,
        contextWindowTokens: 100_000,
        reservedOutputTokens: 10_000,
      },
      pendingToolCallCount: 1,
      pendingOutputCount: 0,
      compactor: createFakeCompactor(),
      emit: async (event) => void emitted.push(event.type),
    });
    expect(unsafe).toMatchObject({ compacted: false, reason: "unsafe_boundary" });
    expect(emitted).toEqual([]);
    expect(state.compaction.snapshots).toHaveLength(0);
  });
});

describe("compaction snapshot fidelity", () => {
  it("keeps authoritative task state and only replaces old history", async () => {
    const state = createState();
    const events = createEvents(200);
    const originalPlan = structuredClone(state.plan);
    const emitted: Array<Record<string, unknown>> = [];

    const outcome = await maybeCompactContext({
      state,
      events,
      usage: {
        estimatedInputTokens: 82_000,
        contextWindowTokens: 100_000,
        reservedOutputTokens: 10_000,
      },
      pendingToolCallCount: 0,
      pendingOutputCount: 0,
      compactor: createFakeCompactor(),
      emit: async (event) => void emitted.push(event),
      now,
    });

    expect(outcome.compacted).toBe(true);
    const snapshot = state.compaction.snapshots.at(-1);
    expect(snapshot?.goal).toBe(state.task);
    expect(snapshot?.pendingWork.map((step) => step.stepId)).toContain("run-tests");
    expect(snapshot?.changedFiles).toEqual(state.changedFiles);
    expect(snapshot?.completedWork).toEqual([
      { stepId: "inspect", evidence: ["read_file observation"] },
    ]);
    expect(state.plan).toEqual(originalPlan);
    expect(state.compaction.compactedThroughEvent).toBe(200);
    expect(emitted.map((event) => event["type"])).toEqual([
      "compaction_started",
      "compaction_completed",
    ]);
    expect(emitted[0]?.["through"]).toBe(200);
  });

  it("rejects a snapshot that drops a pending step or invents evidence", async () => {
    const state = createState();
    const events = createEvents(4);

    await expect(
      buildCompactionSnapshot({
        state,
        events,
        compactor: createFakeCompactor({ pendingWork: [] }),
        now,
      }).then((snapshot) => validateCompaction(snapshot, state, events)),
    ).rejects.toThrow("missing pending step: run-tests");

    await expect(
      buildCompactionSnapshot({
        state,
        events,
        compactor: createFakeCompactor({
          decisions: [{ statement: "凭空结论", evidenceEventIds: ["does-not-exist"] }],
        }),
        now,
      }).then((snapshot) => validateCompaction(snapshot, state, events)),
    ).rejects.toThrow("unknown evidence event: does-not-exist");

    expect(state.compaction.snapshots).toHaveLength(0);
  });

  it("rejects a snapshot that changes the goal, criteria or changed files", async () => {
    const state = createState();
    const events = createEvents(3);

    const wrongGoal = await buildCompactionSnapshot({
      state,
      events,
      compactor: createFakeCompactor({ goal: "另一个目标" }),
      now,
    });
    expect(() => validateCompaction(wrongGoal, state, events)).toThrow("snapshot goal changed");

    const wrongFiles = await buildCompactionSnapshot({
      state,
      events,
      compactor: createFakeCompactor({ changedFiles: [] }),
      now,
    });
    expect(() => validateCompaction(wrongFiles, state, events)).toThrow(
      "missing changed file: src/index.ts",
    );

    const wrongCriteria = await buildCompactionSnapshot({
      state,
      events,
      compactor: createFakeCompactor({ acceptanceCriteria: [] }),
      now,
    });
    expect(() => validateCompaction(wrongCriteria, state, events)).toThrow(
      "acceptance criteria changed during compaction",
    );
  });

  it("keeps a raw tail that overlaps the snapshot and covers the current tool batch", () => {
    const events = createEvents(20);
    events[6] = { ...(events[6] as AgentEvent), type: "tool_batch_started" };
    const snapshot = {
      ...createStateSafeSnapshot(),
      sourceEventRange: { from: 1, to: 10 },
    };

    expect(selectRawTailBoundary(events, snapshot, 3)).toBe(7);

    const projected = projectCompactedContext({ snapshot, events, rawTailSize: 3 });
    expect(projected.rawTail[0]?.sequence).toBe(7);
    expect(projected.rawTail).toHaveLength(14);

    const sources = compactionAsContextSources(projected);
    expect(sources[0]).toMatchObject({ kind: "compaction_snapshot", priority: 95 });
    expect(sources).toHaveLength(15);
  });
});

function createStateSafeSnapshot(): CompactionSnapshot {
  return {
    id: "snapshot-1",
    createdAt: now.toISOString(),
    sourceEventRange: { from: 1, to: 1 },
    goal: "压缩一次长运行",
    constraints: [],
    decisions: [],
    completedWork: [],
    pendingWork: [],
    acceptanceCriteria: [],
    activeSkills: [],
    changedFiles: [],
    validationResults: [],
    unresolvedQuestions: [],
    failedAttempts: [],
    checksum: "checksum",
  };
}
