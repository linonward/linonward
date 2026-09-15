import { randomUUID } from "node:crypto";
import { readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { atomicWriteJson, canonicalJson, isRecord, sha256 } from "./checkpoint.js";
import type { CompactionSnapshot, DurableAgentState, StopReason, TaskPlan } from "./types.js";

export const CHECKPOINT_SCHEMA_VERSION = 1;
export const CHECKPOINT_HISTORY_LIMIT = 2;

export interface PersistedToolCall {
  callId: string;
  name: string;
  argumentsJson: string;
}

export interface PersistedModelTurn {
  responseId: string;
  finalText: string;
  toolCalls: PersistedToolCall[];
}

/** 事件 payload 使用可辨识联合类型，新增结构时按 schemaVersion 迁移。 */
export type DurableEvent =
  | { type: "run_started"; task: string }
  | { type: "plan_updated"; plan: TaskPlan }
  | { type: "model_completed"; responseId: string; turn: PersistedModelTurn }
  | { type: "tool_intent"; call: PersistedToolCall; idempotencyKey: string }
  | { type: "tool_result"; callId: string; idempotencyKey: string; output: string }
  | { type: "compaction_completed"; snapshot: CompactionSnapshot }
  | { type: "run_waiting"; reason: string }
  | { type: "user_input_received"; requestId: string; content: string }
  | { type: "run_stopped"; reason: StopReason };

export interface EventRecord {
  schemaVersion: 1;
  runId: string;
  sequence: number;
  eventId: string;
  recordedAt: string;
  event: DurableEvent;
  checksum: string;
}

export interface RunCheckpoint {
  schemaVersion: 1;
  runId: string;
  throughSequence: number;
  savedAt: string;
  state: DurableAgentState;
  checksum: string;
}

/** ownerId + epoch 提供 fencing；旧 worker 暂停后重新运行会被拒绝。 */
export interface RunLease {
  runId: string;
  ownerId: string;
  epoch: number;
  expiresAt: string;
}

export interface RunStore {
  append(input: {
    runId: string;
    expectedSequence: number;
    ownerId: string;
    epoch: number;
    event: DurableEvent;
    now?: Date | undefined;
  }): Promise<EventRecord>;
  loadCheckpointHistory(runId: string, limit: number): Promise<RunCheckpoint[]>;
  saveCheckpoint(checkpoint: RunCheckpoint, lease: RunLease): Promise<void>;
  readEvents(runId: string, afterSequence: number): Promise<EventRecord[]>;
  acquireLease(runId: string, ownerId: string, ttlMs: number): Promise<RunLease>;
  renewLease(lease: RunLease, ttlMs: number): Promise<RunLease>;
  releaseLease(lease: RunLease): Promise<void>;
}

export function eventRecordChecksum(record: Omit<EventRecord, "checksum">): string {
  return sha256(canonicalJson(record));
}

export function checkpointChecksum(checkpoint: Omit<RunCheckpoint, "checksum">): string {
  return sha256(canonicalJson(checkpoint));
}

export function nextStateSequence(state: DurableAgentState): number {
  return state.nextEventSequence;
}

export function createEventRecord(input: {
  runId: string;
  sequence: number;
  event: DurableEvent;
  now?: Date | undefined;
  eventId?: string | undefined;
}): EventRecord {
  const base: Omit<EventRecord, "checksum"> = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    runId: input.runId,
    sequence: input.sequence,
    eventId: input.eventId ?? randomUUID(),
    recordedAt: (input.now ?? new Date()).toISOString(),
    event: input.event,
  };
  return { ...base, checksum: eventRecordChecksum(base) };
}

export function createRunCheckpoint(input: {
  state: DurableAgentState;
  throughSequence: number;
  now?: Date | undefined;
}): RunCheckpoint {
  const base: Omit<RunCheckpoint, "checksum"> = {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    runId: input.state.runId,
    throughSequence: input.throughSequence,
    savedAt: (input.now ?? new Date()).toISOString(),
    state: input.state,
  };
  return { ...base, checksum: checkpointChecksum(base) };
}

function assertLease(lease: RunLease | undefined, input: { ownerId: string; epoch: number }): void {
  if (!lease) throw new Error("lease_not_held");
  if (lease.ownerId !== input.ownerId || lease.epoch !== input.epoch) {
    throw new Error("stale_lease");
  }
}

function isDurableEvent(value: unknown): value is DurableEvent {
  if (!isRecord(value)) return false;

  switch (value["type"]) {
    case "run_started":
      return typeof value["task"] === "string";
    case "plan_updated":
      return isRecord(value["plan"]);
    case "model_completed":
      return typeof value["responseId"] === "string" && isRecord(value["turn"]);
    case "tool_intent":
      return isRecord(value["call"]) && typeof value["idempotencyKey"] === "string";
    case "tool_result":
      return (
        typeof value["callId"] === "string" &&
        typeof value["idempotencyKey"] === "string" &&
        typeof value["output"] === "string"
      );
    case "compaction_completed":
      return isRecord(value["snapshot"]);
    case "run_waiting":
    case "run_stopped":
      return typeof value["reason"] === "string";
    case "user_input_received":
      return typeof value["requestId"] === "string" && typeof value["content"] === "string";
    default:
      return false;
  }
}

export function isEventRecord(value: unknown): value is EventRecord {
  return (
    isRecord(value) &&
    value["schemaVersion"] === CHECKPOINT_SCHEMA_VERSION &&
    typeof value["runId"] === "string" &&
    typeof value["sequence"] === "number" &&
    typeof value["eventId"] === "string" &&
    typeof value["recordedAt"] === "string" &&
    typeof value["checksum"] === "string" &&
    isDurableEvent(value["event"])
  );
}

export function isRunCheckpoint(value: unknown): value is RunCheckpoint {
  return (
    isRecord(value) &&
    value["schemaVersion"] === CHECKPOINT_SCHEMA_VERSION &&
    typeof value["runId"] === "string" &&
    typeof value["throughSequence"] === "number" &&
    typeof value["savedAt"] === "string" &&
    typeof value["checksum"] === "string" &&
    isRecord(value["state"]) &&
    typeof value["state"]["runId"] === "string" &&
    typeof value["state"]["task"] === "string"
  );
}

export class InMemoryRunStore implements RunStore {
  private readonly events = new Map<string, EventRecord[]>();
  private readonly checkpoints = new Map<string, RunCheckpoint[]>();
  private readonly leases = new Map<string, RunLease>();

  constructor(private readonly clock: () => Date = () => new Date()) {}

  async append(input: {
    runId: string;
    expectedSequence: number;
    ownerId: string;
    epoch: number;
    event: DurableEvent;
    now?: Date | undefined;
  }): Promise<EventRecord> {
    assertLease(this.leases.get(input.runId), input);

    const existing = this.events.get(input.runId) ?? [];
    if (input.expectedSequence !== existing.length + 1) throw new Error("unexpected_sequence");

    const record = createEventRecord({
      runId: input.runId,
      sequence: input.expectedSequence,
      event: input.event,
      now: input.now ?? this.clock(),
    });
    this.events.set(input.runId, [...existing, record]);
    return record;
  }

  async readEvents(runId: string, afterSequence: number): Promise<EventRecord[]> {
    return (this.events.get(runId) ?? [])
      .filter((record) => record.sequence > afterSequence)
      .toSorted((left, right) => left.sequence - right.sequence);
  }

  async saveCheckpoint(checkpoint: RunCheckpoint, lease: RunLease): Promise<void> {
    assertLease(this.leases.get(checkpoint.runId), lease);
    const existing = this.checkpoints.get(checkpoint.runId) ?? [];
    const next = [
      ...existing.filter((item) => item.throughSequence !== checkpoint.throughSequence),
      checkpoint,
    ]
      .toSorted((left, right) => right.throughSequence - left.throughSequence)
      .slice(0, CHECKPOINT_HISTORY_LIMIT);
    this.checkpoints.set(checkpoint.runId, next);
  }

  async loadCheckpointHistory(runId: string, limit: number): Promise<RunCheckpoint[]> {
    return (this.checkpoints.get(runId) ?? [])
      .toSorted((left, right) => right.throughSequence - left.throughSequence)
      .slice(0, limit);
  }

  async acquireLease(runId: string, ownerId: string, ttlMs: number): Promise<RunLease> {
    const now = this.clock();
    const existing = this.leases.get(runId);
    if (
      existing &&
      existing.ownerId !== ownerId &&
      Date.parse(existing.expiresAt) > now.getTime()
    ) {
      throw new Error("lease_held_by_another_worker");
    }

    const lease: RunLease = {
      runId,
      ownerId,
      epoch: existing ? existing.epoch + 1 : 1,
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    };
    this.leases.set(runId, lease);
    return lease;
  }

  async renewLease(lease: RunLease, ttlMs: number): Promise<RunLease> {
    assertLease(this.leases.get(lease.runId), lease);
    const renewed: RunLease = {
      ...lease,
      expiresAt: new Date(this.clock().getTime() + ttlMs).toISOString(),
    };
    this.leases.set(lease.runId, renewed);
    return renewed;
  }

  async releaseLease(lease: RunLease): Promise<void> {
    const existing = this.leases.get(lease.runId);
    if (existing?.ownerId === lease.ownerId && existing.epoch === lease.epoch) {
      this.leases.delete(lease.runId);
    }
  }
}

function padSequence(sequence: number): string {
  return sequence.toString().padStart(8, "0");
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function listJsonFiles(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).filter((name) => name.endsWith(".json")).toSorted();
  } catch {
    return [];
  }
}

/**
 * 本地文件实现：事件 append-only，checkpoint 每版一个文件并保留最后两版，
 * manifest 之外的旧版本在写入新版本后清理。
 */
export class LocalFileRunStore implements RunStore {
  constructor(
    private readonly root: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private runDirectory(runId: string): string {
    return join(this.root, runId);
  }

  private eventPath(runId: string, sequence: number): string {
    return join(this.runDirectory(runId), "events", `${padSequence(sequence)}.json`);
  }

  private checkpointPath(runId: string, throughSequence: number): string {
    return join(this.runDirectory(runId), "checkpoints", `${padSequence(throughSequence)}.json`);
  }

  private leasePath(runId: string): string {
    return join(this.runDirectory(runId), "lease.json");
  }

  private async readLease(runId: string): Promise<RunLease | undefined> {
    const value = await readJson(this.leasePath(runId));
    if (!isRunLease(value)) return undefined;
    return { runId, ownerId: value.ownerId, epoch: value.epoch, expiresAt: value.expiresAt };
  }

  async append(input: {
    runId: string;
    expectedSequence: number;
    ownerId: string;
    epoch: number;
    event: DurableEvent;
    now?: Date | undefined;
  }): Promise<EventRecord> {
    assertLease(await this.readLease(input.runId), input);

    const existing = await this.readEvents(input.runId, 0);
    const last = existing.at(-1);
    const expected = (last?.sequence ?? 0) + 1;
    if (input.expectedSequence !== expected) throw new Error("unexpected_sequence");

    const record = createEventRecord({
      runId: input.runId,
      sequence: input.expectedSequence,
      event: input.event,
      now: input.now ?? this.clock(),
    });
    await atomicWriteJson(this.eventPath(input.runId, record.sequence), record);
    return record;
  }

  async readEvents(runId: string, afterSequence: number): Promise<EventRecord[]> {
    const directory = join(this.runDirectory(runId), "events");
    const records: EventRecord[] = [];

    for (const name of await listJsonFiles(directory)) {
      const value = await readJson(join(directory, name));
      if (!isEventRecord(value)) continue;
      if (value.sequence <= afterSequence) continue;
      records.push(value);
    }

    return records.toSorted((left, right) => left.sequence - right.sequence);
  }

  async saveCheckpoint(checkpoint: RunCheckpoint, lease: RunLease): Promise<void> {
    assertLease(await this.readLease(checkpoint.runId), lease);
    await atomicWriteJson(
      this.checkpointPath(checkpoint.runId, checkpoint.throughSequence),
      checkpoint,
    );

    const directory = join(this.runDirectory(checkpoint.runId), "checkpoints");
    const files = await listJsonFiles(directory);
    const stale = files.slice(0, Math.max(0, files.length - CHECKPOINT_HISTORY_LIMIT));
    for (const name of stale) {
      await rm(join(directory, name), { force: true });
    }
  }

  async loadCheckpointHistory(runId: string, limit: number): Promise<RunCheckpoint[]> {
    const directory = join(this.runDirectory(runId), "checkpoints");
    const names = await listJsonFiles(directory);
    const history: RunCheckpoint[] = [];

    for (const name of names.toReversed()) {
      const value = await readJson(join(directory, name));
      if (!isRunCheckpoint(value)) continue;
      history.push(value);
      if (history.length >= limit) break;
    }

    return history;
  }

  async acquireLease(runId: string, ownerId: string, ttlMs: number): Promise<RunLease> {
    const now = this.clock();
    const existing = await this.readLease(runId);
    if (
      existing &&
      existing.ownerId !== ownerId &&
      Date.parse(existing.expiresAt) > now.getTime()
    ) {
      throw new Error("lease_held_by_another_worker");
    }

    const lease: RunLease = {
      runId,
      ownerId,
      epoch: existing ? existing.epoch + 1 : 1,
      expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    };
    await atomicWriteJson(this.leasePath(runId), lease);
    return lease;
  }

  async renewLease(lease: RunLease, ttlMs: number): Promise<RunLease> {
    assertLease(await this.readLease(lease.runId), lease);
    const renewed: RunLease = {
      ...lease,
      expiresAt: new Date(this.clock().getTime() + ttlMs).toISOString(),
    };
    await atomicWriteJson(this.leasePath(lease.runId), renewed);
    return renewed;
  }

  async releaseLease(lease: RunLease): Promise<void> {
    const existing = await this.readLease(lease.runId);
    if (existing?.ownerId === lease.ownerId && existing.epoch === lease.epoch) {
      await rm(this.leasePath(lease.runId), { force: true });
    }
  }
}

export function isRunLease(value: unknown): value is RunLease {
  return (
    isRecord(value) &&
    typeof value["runId"] === "string" &&
    typeof value["ownerId"] === "string" &&
    typeof value["epoch"] === "number" &&
    typeof value["expiresAt"] === "string"
  );
}
