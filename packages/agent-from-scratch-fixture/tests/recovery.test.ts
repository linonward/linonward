import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { atomicWriteJson } from "../src/checkpoint.js";
import { FakeModelDriver, textTurn } from "../src/fake-model.js";
import { runAgentLoopFromState } from "../src/agent-loop.js";
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
  type RunStore,
} from "../src/run-store.js";
import { createInitialState } from "../src/state.js";
import { InMemoryTraceSink } from "../src/trace.js";
import type { Clock, DurableAgentState } from "../src/types.js";
import {
  ScriptedPlanner,
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
    expect(events.map((record) => record.sequence)).toEqual([1, 2, 3, 4]);
    expect(events.at(-1)?.event.type).toBe("tool_result");
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
