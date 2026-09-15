import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { atomicWriteJson } from "../src/checkpoint.js";
import { FakeModelDriver, textTurn, turnWithTools } from "../src/fake-model.js";
import { runAgentLoop, runAgentLoopFromState, type AgentLoopOptions } from "../src/agent-loop.js";
import { defineTool } from "../src/tool.js";
import {
  assertContiguousSequences,
  findToolIntentsWithoutResults,
  firstValidCheckpoint,
  fromDurableState,
  reduceDurableEvent,
  restoreRun,
  resumeAgentRun,
  toDurableState,
  verifyEventChecksum,
  type AgentRuntime,
  type ToolStateVerifier,
} from "../src/recovery.js";
import {
  InMemoryRunStore,
  LocalFileRunStore,
  createEventRecord,
  createRunCheckpoint,
  isEventRecord,
  type DurableEvent,
  type EventRecord,
  type RunLease,
  type RunStore,
} from "../src/run-store.js";
import type { Planner } from "../src/planner.js";
import { createInitialState } from "../src/state.js";
import { InMemoryTraceSink } from "../src/trace.js";
import type { AgentState, Clock, DurableAgentState } from "../src/types.js";
import {
  ScriptedPlanner,
  completeWith,
  createRegistry,
  criterion,
  echoTool,
  makeDraft,
  makeTaskPlan,
  makeTempDir,
  planStep,
  removeTempDir,
} from "./support.js";

const runId = "run-recovery-1";
const ownerA = "worker-a";
const ownerB = "worker-b";
const fixedNow = new Date("2024-04-01T00:00:00.000Z");
const LEASE_TTL_MS = 30_000;

interface TestClock extends Clock {
  advance(milliseconds: number): void;
}

function testClock(): TestClock {
  let offset = 0;
  return {
    now: () => new Date(fixedNow.getTime() + offset),
    advance: (milliseconds: number) => {
      offset += milliseconds;
    },
  };
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeTempDir(directory)));
});

async function tempDir(): Promise<string> {
  const directory = await makeTempDir("agent-recovery-");
  temporaryDirectories.push(directory);
  return directory;
}

function completedPlan() {
  return makeTaskPlan({
    goal: "完成任务",
    acceptanceCriteria: [criterion("criterion-1", "passed")],
    steps: [planStep("step-1", { status: "completed", evidence: ["evidence"] })],
  });
}

function durableState(overrides: Partial<DurableAgentState> = {}): DurableAgentState {
  const state = createInitialState(
    "完成任务",
    "/workspace",
    { maxSteps: 2, maxToolCalls: 4 },
    { now: fixedNow },
  );
  const durable = toDurableState({ ...state, plan: completedPlan() });
  return {
    ...durable,
    runId,
    events: [],
    nextEventSequence: 4,
    budget: { maxSteps: 2, maxToolCalls: 4, modelSteps: 1, toolCalls: 1 },
    ...overrides,
  };
}

interface CrashFixture {
  store: RunStore;
  clock: TestClock;
  effectCount(): number;
}

/** 复现崩溃点：`tool_intent` 已落盘，副作用是否已经发生由 effectApplied 决定。 */
async function crashFixture(options: {
  store: RunStore;
  clock: TestClock;
  effectApplied: boolean;
}): Promise<CrashFixture> {
  let effectCount = 0;
  const lease = await options.store.acquireLease(runId, ownerA, LEASE_TTL_MS);
  const events: DurableEvent[] = [
    { type: "run_started", task: "完成任务" },
    { type: "plan_updated", plan: completedPlan() },
    {
      type: "tool_intent",
      call: { callId: "call-1", name: "echo", argumentsJson: '{"value":"hi"}' },
      idempotencyKey: `${runId}:call-1`,
    },
  ];

  for (const [index, event] of events.entries()) {
    await options.store.append({
      runId,
      expectedSequence: index + 1,
      ownerId: lease.ownerId,
      epoch: lease.epoch,
      event,
      now: options.clock.now(),
    });
    if (index === events.length - 1 && options.effectApplied) effectCount += 1;
  }

  await options.store.saveCheckpoint(
    createRunCheckpoint({
      state: durableState(),
      throughSequence: events.length,
      now: options.clock.now(),
    }),
    lease,
  );

  return { store: options.store, clock: options.clock, effectCount: () => effectCount };
}

function runtimeFor(options: {
  store: RunStore;
  clock: TestClock;
  skillsDirectory: string;
  verifiers?: Record<string, ToolStateVerifier> | undefined;
}): AgentRuntime {
  return {
    model: new FakeModelDriver([textTurn("恢复后完成", "response-resumed")]),
    planner: new ScriptedPlanner(makeDraft({})),
    tools: createRegistry(echoTool),
    trace: new InMemoryTraceSink(),
    store: options.store,
    clock: options.clock,
    skillsDirectory: options.skillsDirectory,
    toolTimeoutMs: 1_000,
    verifiers: options.verifiers,
  };
}

const appliedVerifier: ToolStateVerifier = {
  async verify() {
    return { status: "applied", output: JSON.stringify({ ok: true, data: { echoed: "hi" } }) };
  },
};

const notAppliedVerifier: ToolStateVerifier = {
  async verify() {
    return { status: "not_applied" };
  },
};

describe("run store fencing and event log", () => {
  it("rejects writes from a stale epoch and from a competing owner", async () => {
    const store = new InMemoryRunStore(() => fixedNow);
    const leaseA = await store.acquireLease(runId, ownerA, LEASE_TTL_MS);

    await expect(store.acquireLease(runId, ownerB, LEASE_TTL_MS)).rejects.toThrow(
      "lease_held_by_another_worker",
    );

    const leaseB = await store.acquireLease(runId, ownerA, LEASE_TTL_MS);
    expect(leaseB.epoch).toBe(leaseA.epoch + 1);

    await expect(
      store.append({
        runId,
        expectedSequence: 1,
        ownerId: ownerA,
        epoch: leaseA.epoch,
        event: { type: "run_started", task: "完成任务" },
        now: fixedNow,
      }),
    ).rejects.toThrow("stale_lease");

    await store.append({
      runId,
      expectedSequence: 1,
      ownerId: ownerA,
      epoch: leaseB.epoch,
      event: { type: "run_started", task: "完成任务" },
      now: fixedNow,
    });
    await expect(
      store.append({
        runId,
        expectedSequence: 3,
        ownerId: ownerA,
        epoch: leaseB.epoch,
        event: { type: "run_stopped", reason: "final_answer" },
        now: fixedNow,
      }),
    ).rejects.toThrow("unexpected_sequence");
  });

  it("detects sequence gaps and corrupted checksums", () => {
    const records = [1, 2, 4].map((sequence) =>
      createEventRecord({
        runId,
        sequence,
        event: { type: "run_started", task: "任务" },
        now: fixedNow,
        eventId: `event-${sequence}`,
      }),
    );

    expect(() => assertContiguousSequences(records, 1)).toThrow("event_sequence_gap");

    const good = createEventRecord({
      runId,
      sequence: 1,
      event: { type: "run_started", task: "任务" },
      now: fixedNow,
    });
    expect(() => verifyEventChecksum(good)).not.toThrow();
    expect(() =>
      verifyEventChecksum({ ...good, event: { type: "run_started", task: "被篡改" } }),
    ).toThrow("event_checksum_mismatch");
  });

  it("falls back to the previous checkpoint version when the newest one is corrupted", async () => {
    const root = await tempDir();
    const clock = testClock();
    const store = new LocalFileRunStore(root, clock.now);
    const lease = await store.acquireLease(runId, ownerA, LEASE_TTL_MS);

    await store.append({
      runId,
      expectedSequence: 1,
      ownerId: lease.ownerId,
      epoch: lease.epoch,
      event: { type: "run_started", task: "完成任务" },
      now: clock.now(),
    });
    await store.saveCheckpoint(
      createRunCheckpoint({
        state: durableState({ nextEventSequence: 2 }),
        throughSequence: 1,
        now: clock.now(),
      }),
      lease,
    );
    await store.append({
      runId,
      expectedSequence: 2,
      ownerId: lease.ownerId,
      epoch: lease.epoch,
      event: { type: "plan_updated", plan: completedPlan() },
      now: clock.now(),
    });
    await store.saveCheckpoint(
      createRunCheckpoint({ state: durableState(), throughSequence: 2, now: clock.now() }),
      lease,
    );

    // 破坏最新一版，只保留旧版可用。
    await atomicWriteJson(join(root, runId, "checkpoints", "00000002.json"), {
      schemaVersion: 1,
      runId,
      throughSequence: 2,
      savedAt: fixedNow.toISOString(),
      state: durableState(),
      checksum: "corrupted",
    });

    const history = await store.loadCheckpointHistory(runId, 2);
    expect(history).toHaveLength(2);
    expect(firstValidCheckpoint(history)?.throughSequence).toBe(1);

    clock.advance(LEASE_TTL_MS * 2);
    const restored = await restoreRun({ runId, ownerId: ownerB, store });
    expect(restored.lease.epoch).toBe(lease.epoch + 1);
    expect(restored.state.plan.goal).toBe("完成任务");
  });
});

describe("crash recovery", () => {
  it("applies the external effect exactly once when the crash happened after the effect", async () => {
    const skillsDirectory = await tempDir();
    const clock = testClock();
    const fixture = await crashFixture({
      store: new InMemoryRunStore(clock.now),
      clock,
      effectApplied: true,
    });
    clock.advance(LEASE_TTL_MS * 2);

    const result = await resumeAgentRun(
      runId,
      runtimeFor({
        store: fixture.store,
        clock,
        skillsDirectory,
        verifiers: { echo: appliedVerifier },
      }),
    );

    expect(result.stopReason).toBe("final_answer");
    expect(result.status).toBe("completed");
    // 对账只补写 tool_result，绝不重复执行副作用。
    expect(fixture.effectCount()).toBe(1);

    const events = await fixture.store.readEvents(runId, 0);
    // 对账补写 tool_result 之后，Loop 继续逐事件 flush，sequence 必须保持连续。
    expect(events.map((record) => record.sequence)).toEqual(
      Array.from({ length: events.length }, (_value, index) => index + 1),
    );
    expect(events.slice(0, 4).map((record) => record.event.type)).toEqual([
      "run_started",
      "plan_updated",
      "tool_intent",
      "tool_result",
    ]);
    expect(events.at(-1)?.event.type).toBe("run_stopped");
    expect(events.every(isEventRecord)).toBe(true);
  });

  it("records a not_applied observation instead of guessing", async () => {
    const skillsDirectory = await tempDir();
    const clock = testClock();
    const fixture = await crashFixture({
      store: new InMemoryRunStore(clock.now),
      clock,
      effectApplied: false,
    });
    clock.advance(LEASE_TTL_MS * 2);

    const result = await resumeAgentRun(
      runId,
      runtimeFor({
        store: fixture.store,
        clock,
        skillsDirectory,
        verifiers: { echo: notAppliedVerifier },
      }),
    );

    expect(result.stopReason).toBe("final_answer");
    expect(fixture.effectCount()).toBe(0);
    const events = await fixture.store.readEvents(runId, 0);
    const toolResult = events.find((record) => record.event.type === "tool_result");
    expect(JSON.stringify(toolResult?.event)).toContain("tool_not_applied");
  });

  it("stops with interrupted and a persisted request when no verifier exists", async () => {
    const skillsDirectory = await tempDir();
    const clock = testClock();
    const fixture = await crashFixture({
      store: new InMemoryRunStore(clock.now),
      clock,
      effectApplied: true,
    });
    clock.advance(LEASE_TTL_MS * 2);

    const result = await resumeAgentRun(
      runId,
      runtimeFor({ store: fixture.store, clock, skillsDirectory }),
    );

    expect(result.stopReason).toBe("interrupted");
    expect(result.status).toBe("waiting");
    expect(result.state.pendingUserInput?.kind).toBe("manual_reconciliation");
  });

  it("resumes without resetting the budget", async () => {
    const skillsDirectory = await tempDir();
    const clock = testClock();
    const store = new InMemoryRunStore(clock.now);
    await crashFixture({ store, clock, effectApplied: false });
    clock.advance(LEASE_TTL_MS * 2);

    const result = await resumeAgentRun(
      runId,
      runtimeFor({ store, clock, skillsDirectory, verifiers: { echo: notAppliedVerifier } }),
    );

    expect(result.stopReason).toBe("final_answer");
    expect(result.state.budget.modelSteps).toBe(2);
    expect(result.state.budget.maxSteps).toBe(2);
    expect(result.state.budget.toolCalls).toBe(1);
  });

  it("refuses to resume while another worker holds a live lease", async () => {
    const skillsDirectory = await tempDir();
    const clock = testClock();
    const fixture = await crashFixture({
      store: new InMemoryRunStore(clock.now),
      clock,
      effectApplied: true,
    });

    await expect(
      resumeAgentRun(
        runId,
        runtimeFor({
          store: fixture.store,
          clock,
          skillsDirectory,
          verifiers: { echo: appliedVerifier },
        }),
      ),
    ).rejects.toThrow("lease_held_by_another_worker");
  });
});

describe("recovery projections", () => {
  it("computes in-flight intents from the full event history", () => {
    const records: EventRecord[] = [
      createEventRecord({
        runId,
        sequence: 1,
        event: {
          type: "tool_intent",
          call: { callId: "call-1", name: "echo", argumentsJson: "{}" },
          idempotencyKey: "k1",
        },
        now: fixedNow,
      }),
      createEventRecord({
        runId,
        sequence: 2,
        event: { type: "tool_result", callId: "call-1", idempotencyKey: "k1", output: "{}" },
        now: fixedNow,
      }),
      createEventRecord({
        runId,
        sequence: 3,
        event: {
          type: "tool_intent",
          call: { callId: "call-2", name: "echo", argumentsJson: "{}" },
          idempotencyKey: "k2",
        },
        now: fixedNow,
      }),
    ];

    expect(findToolIntentsWithoutResults(records).map((call) => call.callId)).toEqual(["call-2"]);
  });

  it("replays events deterministically and round-trips durable state", () => {
    const durable = durableState({ contextSources: [] });
    const event: DurableEvent = {
      type: "tool_result",
      callId: "call-9",
      idempotencyKey: "k9",
      output: '{"ok":true}',
    };
    const replay = reduceDurableEvent(durable, event);
    const again = reduceDurableEvent(durable, event);

    expect(JSON.stringify(replay.contextSources)).toBe(JSON.stringify(again.contextSources));
    expect(replay.contextSources[0]).toMatchObject({ id: "call-9", kind: "tool_observation" });

    const roundTripped = toDurableState(fromDurableState(replay), undefined);
    expect(roundTripped.runId).toBe(replay.runId);
    expect(roundTripped.plan).toEqual(replay.plan);
    expect(roundTripped.budget).toEqual(replay.budget);
    expect(roundTripped.nextEventSequence).toBe(replay.nextEventSequence);
  });

  it("continues from a restored state without recreating the plan", async () => {
    const cwd = await tempDir();
    const state = fromDurableState(
      durableState({ cwd, nextEventSequence: 1, events: [], status: "running" }),
    );
    const planner = new ScriptedPlanner(makeDraft({}));

    const result = await runAgentLoopFromState(state, {
      cwd,
      skillsDirectory: cwd,
      maxSteps: 3,
      maxToolCalls: 3,
      toolTimeoutMs: 500,
      model: new FakeModelDriver([textTurn("继续完成", "response-1")]),
      planner,
      tools: createRegistry(echoTool),
      trace: new InMemoryTraceSink(),
    });

    expect(result.stopReason).toBe("final_answer");
    expect(planner.createInputs).toHaveLength(0);
    expect(result.state.plan?.goal).toBe("完成任务");
    expect(result.state.runId).toBe(runId);
  });
});

/** append 到第 N 次时抛出 `simulated_crash`，复现"进程在写事件时崩溃"。 */
class CrashingRunStore implements RunStore {
  constructor(
    private readonly inner: RunStore,
    private readonly crashAfterAppends: number,
  ) {}

  private appends = 0;

  async append(
    input: Parameters<RunStore["append"]>[0],
  ): Promise<Awaited<ReturnType<RunStore["append"]>>> {
    this.appends += 1;
    if (this.appends > this.crashAfterAppends) throw new Error("simulated_crash");
    return this.inner.append(input);
  }

  async loadCheckpointHistory(runId: string, limit: number) {
    return this.inner.loadCheckpointHistory(runId, limit);
  }

  async saveCheckpoint(
    checkpoint: Parameters<RunStore["saveCheckpoint"]>[0],
    lease: RunLease,
  ): Promise<void> {
    return this.inner.saveCheckpoint(checkpoint, lease);
  }

  async readEvents(runId: string, afterSequence: number) {
    return this.inner.readEvents(runId, afterSequence);
  }

  async acquireLease(runId: string, ownerId: string, ttlMs: number) {
    return this.inner.acquireLease(runId, ownerId, ttlMs);
  }

  async renewLease(lease: RunLease, ttlMs: number) {
    return this.inner.renewLease(lease, ttlMs);
  }

  async releaseLease(lease: RunLease): Promise<void> {
    return this.inner.releaseLease(lease);
  }
}

function loopRuntime(input: {
  store: RunStore;
  clock: TestClock;
  skillsDirectory: string;
  verifiers?: Record<string, ToolStateVerifier> | undefined;
  verifierCalls?: { count: number } | undefined;
  planner?: Planner | undefined;
}): AgentRuntime {
  return {
    model: new FakeModelDriver([textTurn("恢复后完成", "response-resumed")]),
    planner: input.planner ?? new ScriptedPlanner(makeDraft({})),
    tools: createRegistry(echoTool),
    trace: new InMemoryTraceSink(),
    store: input.store,
    clock: input.clock,
    skillsDirectory: input.skillsDirectory,
    toolTimeoutMs: 1_000,
    verifiers: input.verifiers,
  };
}

describe("agent loop persistence and crash recovery", () => {
  it("resumes a real loop crash from the same event log without repeating side effects", async () => {
    const skillsDirectory = await tempDir();
    const clock = testClock();
    const inner = new InMemoryRunStore(clock.now);
    // 第 5 次 append（tool_result）时崩溃，副作用已经发生但 observation 未落盘。
    const store = new CrashingRunStore(inner, 4);
    const lease = await store.acquireLease(runId, ownerA, LEASE_TTL_MS);

    let effectCount = 0;
    const verifierCalls: string[] = [];
    const crashingTool = defineTool({
      name: "write_artifact",
      description: "拥有副作用的工具：崩溃恢复后必须只执行一次。",
      effect: "read",
      schema: z.object({ value: z.string().min(1) }).strict(),
      async execute(input) {
        effectCount += 1;
        return { written: input.value };
      },
    });
    const artifactCall = (callId: string) => ({
      callId,
      name: "write_artifact",
      argumentsJson: JSON.stringify({ value: "artifact" }),
    });
    const artifactObservation = JSON.stringify({ ok: true, data: { written: "artifact" } });

    const planner = new ScriptedPlanner(
      makeDraft({ steps: [{ id: "step-1", title: "写入 artifact" }] }),
      [completeWith([artifactObservation], ["criterion-1"])],
    );
    const driver = new FakeModelDriver([
      turnWithTools(artifactCall("call-1")),
      turnWithTools(artifactCall("call-2")),
    ]);

    // 持久化围栏把 store 故障转成一次安全的停止，而不是让进程崩溃：
    // 事件日志停在第 4 条，副作用已经发生但 observation 未落盘。
    const crashed = await runAgentLoop("写一次 artifact", {
      cwd: skillsDirectory,
      skillsDirectory,
      runId,
      maxSteps: 4,
      maxToolCalls: 4,
      toolTimeoutMs: 1_000,
      model: driver,
      planner,
      tools: createRegistry(crashingTool),
      trace: new InMemoryTraceSink(),
      persistence: { store, lease },
    });
    expect(crashed.status).toBe("failed");
    expect(crashed.stopReason).toBe("interrupted");

    expect(effectCount).toBe(1);
    const before = await inner.readEvents(runId, 0);
    expect(before.map((record) => record.event.type)).toEqual([
      "run_started",
      "plan_updated",
      "model_completed",
      "tool_intent",
    ]);
    expect(findToolIntentsWithoutResults(before).map((call) => call.callId)).toEqual(["call-1"]);

    clock.advance(LEASE_TTL_MS * 2);
    const verifier: ToolStateVerifier = {
      async verify(input) {
        verifierCalls.push(input.call.callId);
        return { status: "applied", output: artifactObservation };
      },
    };

    const result = await resumeAgentRun(
      runId,
      loopRuntime({
        store: inner,
        clock,
        skillsDirectory,
        verifiers: { write_artifact: verifier },
        // 续跑第一轮必须把对账回来的 observation 归约进计划：
        // 计划里 step-1 还没完成，这一步由 planner.evaluate 补齐。
        planner: new ScriptedPlanner(
          makeDraft({ steps: [{ id: "step-1", title: "写入 artifact" }] }),
          [completeWith([artifactObservation], ["criterion-1"])],
        ),
      }),
    );

    expect(result.status).toBe("completed");
    expect(result.stopReason).toBe("final_answer");
    expect(result.state.runId).toBe(runId);
    // 对账只确认，不重复执行副作用。
    expect(effectCount).toBe(1);
    expect(verifierCalls).toEqual(["call-1"]);
    // 预算从原值继续，而不是被重置：崩溃前 1 轮模型 + 1 次工具调用，续跑再 +1 轮模型。
    expect(result.state.budget.modelSteps).toBe(2);
    expect(result.state.budget.toolCalls).toBe(1);
    expect(result.state.budget.maxSteps).toBe(4);

    const after = await inner.readEvents(runId, 0);
    expect(after.map((record) => record.sequence)).toEqual(
      Array.from({ length: after.length }, (_value, index) => index + 1),
    );
    // 崩溃时的 in-flight 调用只补一次 tool_result，没有重复执行。
    expect(after.filter((record) => record.event.type === "tool_intent")).toHaveLength(1);
    expect(after.filter((record) => record.event.type === "tool_result")).toHaveLength(1);
    expect(after.at(-1)?.event).toMatchObject({ type: "run_stopped", reason: "final_answer" });
    expect(after.every(isEventRecord)).toBe(true);
  });

  it("stops with interrupted instead of forking history when the lease epoch moves on", async () => {
    const skillsDirectory = await tempDir();
    const clock = testClock();
    const store = new InMemoryRunStore(clock.now);
    const lease = await store.acquireLease(runId, ownerA, LEASE_TTL_MS);

    const runState = (): AgentState => {
      const state = createInitialState(
        "被抢占的运行",
        skillsDirectory,
        { maxSteps: 4, maxToolCalls: 4 },
        { now: clock.now(), runId },
      );
      // 计划已完成、验收条件已通过：本轮只等模型给出最终文本，
      // 这样测试的焦点完全落在 lease fencing 上，而不是计划推进。
      state.plan = makeTaskPlan({
        goal: "被抢占的运行",
        acceptanceCriteria: [criterion("criterion-1", "passed")],
        steps: [planStep("step-1", { status: "completed", evidence: ["done"] })],
      });
      state.requiredCriterionIds = ["criterion-1"];
      return state;
    };
    const draft = makeDraft({
      criteria: [{ id: "criterion-1", description: "任务结果可验证" }],
      steps: [{ id: "step-1", title: "完成被抢占的运行" }],
    });
    const loopOptions = (model: FakeModelDriver): AgentLoopOptions => ({
      cwd: skillsDirectory,
      skillsDirectory,
      maxSteps: 4,
      maxToolCalls: 4,
      toolTimeoutMs: 1_000,
      model,
      planner: new ScriptedPlanner(draft),
      tools: createRegistry(echoTool),
      trace: new InMemoryTraceSink(),
      persistence: { store, lease },
    });

    // 第一段：旧 lease 仍然有效，运行正常完成并写了事件与检查点。
    const completedRun = await runAgentLoopFromState(
      runState(),
      loopOptions(new FakeModelDriver([textTurn("正常完成", "response-1")])),
    );
    expect(completedRun.status).toBe("completed");

    const beforeTakeover = await store.readEvents(runId, 0);
    expect(beforeTakeover.length).toBeGreaterThan(0);
    expect(beforeTakeover.map((record) => record.sequence)).toEqual(
      Array.from({ length: beforeTakeover.length }, (_value, index) => index + 1),
    );

    // 另一个 worker 接管：epoch 前进，旧 lease 立即失效。
    clock.advance(LEASE_TTL_MS * 2);
    const takeOver = await store.acquireLease(runId, ownerB, LEASE_TTL_MS);
    expect(takeOver.epoch).toBe(lease.epoch + 1);

    const staleResult = await runAgentLoopFromState(
      runState(),
      loopOptions(new FakeModelDriver([textTurn("不该被接受", "response-2")])),
    );

    expect(staleResult.status).toBe("failed");
    expect(staleResult.stopReason).toBe("interrupted");
    // 围栏拒绝后不得再写 store，也不得换一个 runId 分叉历史。
    const after = await store.readEvents(runId, 0);
    expect(after.map((record) => record.sequence)).toEqual(
      beforeTakeover.map((record) => record.sequence),
    );
    expect(after.every(isEventRecord)).toBe(true);
  });
});
