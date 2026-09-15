import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  type AgentLoopOptions,
  type LoopCompactionOptions,
  runAgentLoop,
} from "../src/agent-loop.js";
import {
  buildCompactionSnapshot,
  type Compactor,
  compactionAsContextSources,
  isSafeCompactionBoundary,
  maybeCompactContext,
  projectCompactedContext,
  selectRawTailBoundary,
  shouldCompact,
  validateCompaction,
} from "../src/compaction.js";
import { FakeModelDriver, textTurn, turnWithTools } from "../src/fake-model.js";
import { createInitialState } from "../src/state.js";
import { defineTool } from "../src/tool.js";
import { InMemoryTraceSink } from "../src/trace.js";
import type { AgentEvent, AgentState, CompactionSnapshot } from "../src/types.js";
import {
  completeWith,
  createRegistry,
  criterion,
  makeDraft,
  makeTaskPlan,
  makeTempDir,
  planStep,
  removeTempDir,
  ScriptedPlanner,
} from "./support.js";

type Draft = Omit<CompactionSnapshot, "id" | "createdAt" | "checksum">;

const now = new Date("2024-03-01T00:00:00.000Z");

function createFakeCompactor(overrides: Partial<Draft> = {}): Compactor {
  return {
    async compact(input) {
      return {
        sourceEventRange: { from: 0, to: 0 },
        goal: input.task,
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
        constraints: [...input.constraints],
        failedAttempts: [...input.failedAttempts],
        validationResults: input.validationResults,
        unresolvedQuestions: [...input.unresolvedQuestions],
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

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeTempDir(directory)));
});

async function tempDir(): Promise<string> {
  const directory = await makeTempDir("agent-compaction-loop-");
  temporaryDirectories.push(directory);
  return directory;
}

const historyTool = defineTool({
  name: "read_history",
  description: "Return a large observation so the context crosses the compaction threshold.",
  effect: "read",
  schema: z.object({ blob: z.string().min(1) }).strict(),
  async execute(input) {
    return { blob: input.blob };
  },
});

function historyCall(callId: string, blobText: string) {
  return { callId, name: "read_history", argumentsJson: JSON.stringify({ blob: blobText }) };
}

/** Executor 会把工具返回值包成 `{ ok, data }`，证据必须与 observation 完全一致。 */
function historyObservation(blobText: string): string {
  return JSON.stringify({ ok: true, data: { blob: blobText } });
}

/** 只统计字符数的确定性估算器，避免测试依赖 tokenizer。 */
function charactersEstimator(multiplier = 1) {
  return (input: { sources: Array<{ content: string }>; instructions: string }): number =>
    input.sources.reduce((total, source) => total + source.content.length, 0) * multiplier;
}

function compactionOptions(
  compactor: Compactor,
  contextWindowTokens: number,
  estimateInputTokens = charactersEstimator(),
): LoopCompactionOptions {
  return {
    compactor,
    contextWindowTokens,
    reservedOutputTokens: 0,
    rawTailSize: 2,
    estimateInputTokens,
  };
}

function loopOptions(
  cwd: string,
  input: {
    driver: FakeModelDriver;
    planner: ScriptedPlanner;
    compaction: LoopCompactionOptions;
  },
): AgentLoopOptions {
  return {
    cwd,
    skillsDirectory: cwd,
    maxSteps: 8,
    maxToolCalls: 8,
    toolTimeoutMs: 2_000,
    model: input.driver,
    planner: input.planner,
    tools: createRegistry(historyTool),
    trace: new InMemoryTraceSink(),
    compaction: input.compaction,
  };
}

const blob = "x".repeat(1_200);

/**
 * 每次调用带上不同的前缀，避免触发重复调用守卫（这个 fixture 验证的是压缩，
 * 而不是重复调用）。`blob` 仍然是每条 observation 的子串，既有断言不变。
 */
function markedBlob(index: number): string {
  return `${index}:${blob}`;
}

describe("agent loop compaction wiring", () => {
  it("compacts inside the loop and projects snapshot plus raw tail into the next request", async () => {
    const cwd = await tempDir();
    const driver = new FakeModelDriver([
      turnWithTools(
        historyCall("call-1", markedBlob(1)),
        historyCall("call-2", markedBlob(2)),
        historyCall("call-3", markedBlob(3)),
      ),
      turnWithTools(historyCall("call-4", markedBlob(4))),
      textTurn("已经完成。", "response-final"),
    ]);
    const planner = new ScriptedPlanner(
      makeDraft({
        steps: [
          { id: "inspect", title: "读取历史" },
          { id: "summarize", title: "总结并完成" },
        ],
      }),
      [
        completeWith(
          [
            historyObservation(markedBlob(1)),
            historyObservation(markedBlob(2)),
            historyObservation(markedBlob(3)),
          ],
          ["criterion-1"],
        ),
        completeWith([historyObservation(markedBlob(4))], []),
      ],
    );

    const result = await runAgentLoop(
      "压缩长运行",
      loopOptions(cwd, {
        driver,
        planner,
        compaction: compactionOptions(createFakeCompactor(), 400),
      }),
    );

    expect(result.stopReason).toBe("final_answer");
    expect(result.state.compaction.snapshots.length).toBeGreaterThanOrEqual(1);

    // 第二轮请求是被压缩后组装的：既有快照来源，也有 rawTail 里的原始观察。
    const compactedRequest = driver.turns[1]?.request;
    if (compactedRequest === undefined) throw new Error("second model request missing");
    const rendered = JSON.stringify(compactedRequest);
    expect(rendered).toContain("compaction_snapshot");
    expect(rendered).toContain(blob);

    // 被快照覆盖的 call-1 ~ call-3 不再是独立 context source，避免与 rawTail 重复。
    expect(
      result.state.contextSources.filter((source) => source.kind === "tool_observation"),
    ).toEqual([]);
    expect(
      result.state.contextSources.some((source) => source.kind === "compaction_snapshot"),
    ).toBe(false);
  });

  it("does not compact below the threshold and keeps observations in context", async () => {
    const cwd = await tempDir();
    const driver = new FakeModelDriver([
      turnWithTools(historyCall("call-1", blob), historyCall("call-2", blob)),
      textTurn("已完成。", "response-final"),
    ]);
    const planner = new ScriptedPlanner(
      makeDraft({ steps: [{ id: "inspect", title: "读取历史" }] }),
      [completeWith([historyObservation(blob)], ["criterion-1"])],
    );

    const result = await runAgentLoop(
      "短运行",
      loopOptions(cwd, {
        driver,
        planner,
        compaction: compactionOptions(createFakeCompactor(), 1_000_000),
      }),
    );

    expect(result.stopReason).toBe("final_answer");
    expect(result.state.compaction.snapshots).toHaveLength(0);
    expect(
      result.state.contextSources.filter((source) => source.kind === "tool_observation"),
    ).toHaveLength(2);
  });

  it("stops with compaction_failed after two consecutive rejected snapshots", async () => {
    const cwd = await tempDir();
    const driver = new FakeModelDriver([
      turnWithTools(historyCall("call-1", blob), historyCall("call-2", blob)),
      textTurn("不应该到达这里。", "response-final"),
    ]);
    const planner = new ScriptedPlanner(
      makeDraft({
        steps: [
          { id: "inspect", title: "读取历史" },
          { id: "verify", title: "验证结果" },
        ],
      }),
      [completeWith([historyObservation(blob)], ["criterion-1"])],
    );

    const result = await runAgentLoop(
      "坏压缩器",
      loopOptions(cwd, {
        driver,
        planner,
        // 漏掉 pending step，validateCompaction 必须拒绝。
        compaction: compactionOptions(createFakeCompactor({ pendingWork: [] }), 400),
      }),
    );

    expect(result.stopReason).toBe("compaction_failed");
    expect(result.status).toBe("failed");
    expect(result.state.compaction.snapshots).toHaveLength(0);
    // 原上下文与观察都还在，没有换用"差不多"的摘要。
    const rejected = result.state.events.filter((event) => event.type === "compaction_rejected");
    expect(rejected.map((event) => event.detail).join(" ")).toContain(
      "missing pending step: verify",
    );
    // 压缩失败不是工具失败：不能污染 failedAttempts（它是 shouldReplan 与快照投影的输入）。
    expect(result.state.failedAttempts).toEqual([]);
    expect(
      result.state.contextSources.filter((source) => source.kind === "tool_observation"),
    ).toHaveLength(2);
  });
});
