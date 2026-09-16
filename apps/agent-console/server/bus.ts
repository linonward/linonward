import type { JournalRecord } from "../src/lib/journal.js";

/** 频道里的一条记录：`seq` 从 1 开始，客户端用 `after=<seq>` 续订，不会重复。 */
export interface StoredEntry {
  seq: number;
  record: JournalRecord;
}

export interface ChannelSubscriber {
  onEntry(entry: StoredEntry): void;
  onDone(): void;
}

/**
 * 一次运行的事件频道。
 *
 * 记录先入缓冲区再推给订阅者，因此"先返回 runId、后建立 SSE"不会丢事件；
 * `after` 让重连（例如审批之后继续运行）只补发没见过的部分。
 */
export interface RunChannel {
  readonly runId: string;
  readonly done: boolean;
  readonly size: number;
  readonly lastSeq: number;
  push(record: JournalRecord): number;
  finish(): void;
  /** 审批 / 澄清之后继续运行：重置 done，允许重新订阅。 */
  reopen(): void;
  subscribe(after: number, subscriber: ChannelSubscriber): () => void;
}

/**
 * 缓冲区上限：本地长时间运行也不至于无界占内存。
 * 超出后丢弃最旧的条目；`seq` 仍然单调递增，因此 `after` 续订语义不受影响。
 */
export const MAX_CHANNEL_ENTRIES = 2_000;

class Channel implements RunChannel {
  private entries: StoredEntry[] = [];
  private subscribers = new Set<ChannelSubscriber>();
  private nextSeq = 1;
  private finished = false;

  constructor(readonly runId: string) {}

  get done(): boolean {
    return this.finished;
  }

  get size(): number {
    return this.entries.length;
  }

  get lastSeq(): number {
    return this.nextSeq - 1;
  }

  push(record: JournalRecord): number {
    const seq = this.nextSeq;
    this.nextSeq += 1;
    this.entries.push({ seq, record });
    if (this.entries.length > MAX_CHANNEL_ENTRIES) {
      this.entries = this.entries.slice(this.entries.length - MAX_CHANNEL_ENTRIES);
    }
    for (const subscriber of [...this.subscribers]) subscriber.onEntry({ seq, record });
    return seq;
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    const subscribers = [...this.subscribers];
    this.subscribers.clear();
    for (const subscriber of subscribers) subscriber.onDone();
  }

  reopen(): void {
    this.finished = false;
  }

  subscribe(after: number, subscriber: ChannelSubscriber): () => void {
    for (const entry of this.entries) {
      if (entry.seq > after) subscriber.onEntry(entry);
    }
    if (this.finished) {
      subscriber.onDone();
      return () => undefined;
    }
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }
}

/** 进程内的运行事件总线：runId → 频道。 */
export class RunHub {
  private readonly channels = new Map<string, RunChannel>();

  create(runId: string): RunChannel {
    const existing = this.channels.get(runId);
    if (existing !== undefined) return existing;
    const channel = new Channel(runId);
    this.channels.set(runId, channel);
    return channel;
  }

  get(runId: string): RunChannel | undefined {
    return this.channels.get(runId);
  }

  delete(runId: string): void {
    this.channels.delete(runId);
  }

  runIds(): string[] {
    return [...this.channels.keys()];
  }
}
