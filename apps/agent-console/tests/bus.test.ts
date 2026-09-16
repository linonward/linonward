import { describe, expect, it } from "vitest";

import { MAX_CHANNEL_ENTRIES, RunHub, type StoredEntry } from "../server/bus.js";

describe("RunHub", () => {
  it("先入缓冲区：晚订阅者也能拿到全部历史记录", () => {
    const hub = new RunHub();
    const channel = hub.create("run-1");
    channel.push({ kind: "run_started" });
    channel.push({ kind: "model_request", step: 1 });

    const seen: number[] = [];
    channel.subscribe(0, {
      onEntry: (entry) => seen.push(entry.seq),
      onDone: () => seen.push(-1),
    });

    expect(seen).toEqual([1, 2]);
  });

  it("after 只补发没见过的部分，实时记录继续推送", () => {
    const hub = new RunHub();
    const channel = hub.create("run-1");
    channel.push({ kind: "a" });
    channel.push({ kind: "b" });

    const seen: StoredEntry[] = [];
    let done = false;
    channel.subscribe(1, {
      onEntry: (entry) => seen.push(entry),
      onDone: () => {
        done = true;
      },
    });
    channel.push({ kind: "c" });

    expect(seen.map((entry) => entry.record["kind"])).toEqual(["b", "c"]);
    expect(done).toBe(false);
  });

  it("finish 之后订阅者立刻收到 done；reopen 之后又能继续订阅", () => {
    const hub = new RunHub();
    const channel = hub.create("run-1");
    channel.push({ kind: "a" });
    channel.finish();

    let doneCount = 0;
    channel.subscribe(0, { onEntry: () => undefined, onDone: () => (doneCount += 1) });
    expect(doneCount).toBe(1);
    expect(channel.done).toBe(true);

    channel.reopen();
    let resumed = 0;
    const unsubscribe = channel.subscribe(1, {
      onEntry: () => (resumed += 1),
      onDone: () => undefined,
    });
    channel.push({ kind: "b" });
    expect(resumed).toBe(1);
    unsubscribe();
    channel.push({ kind: "c" });
    expect(resumed).toBe(1);
  });

  it("缓冲区有上限，但 seq 仍然单调递增", () => {
    const hub = new RunHub();
    const channel = hub.create("run-1");
    for (let index = 0; index < MAX_CHANNEL_ENTRIES + 10; index += 1) {
      channel.push({ kind: "log_line", text: String(index) });
    }

    expect(channel.size).toBe(MAX_CHANNEL_ENTRIES);
    expect(channel.lastSeq).toBe(MAX_CHANNEL_ENTRIES + 10);

    const seen: number[] = [];
    channel.subscribe(MAX_CHANNEL_ENTRIES + 5, {
      onEntry: (entry) => seen.push(entry.seq),
      onDone: () => undefined,
    });
    expect(seen).toEqual([
      MAX_CHANNEL_ENTRIES + 6,
      MAX_CHANNEL_ENTRIES + 7,
      MAX_CHANNEL_ENTRIES + 8,
      MAX_CHANNEL_ENTRIES + 9,
      MAX_CHANNEL_ENTRIES + 10,
    ]);
  });
});
