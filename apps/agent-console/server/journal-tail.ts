import { readFileSync } from "node:fs";

/** 反向扫描的上限：只可能出现在结尾附近，避免为了兜底读完一个很大的 journal。 */
export const WAITING_SCAN_MAX_LINES = 5_000;

import { type JournalRecord, parseJournalRecord } from "../src/lib/journal.js";

export interface JournalTailerOptions {
  path: string;
  onRecord(record: JournalRecord): void;
  /** 轮询间隔；本地工具，20ms 足够让界面感觉是实时的。 */
  intervalMs?: number | undefined;
}

export interface JournalTailer {
  /** 立即读取新增的完整行；运行结束时用它保证"记录先于 done 到达"。 */
  flush(): void;
  stop(): void;
}

/**
 * JSONL 增量读取器。
 *
 * `createJournal` 的 `logPath` 是唯一能拿到**结构化**记录（带 `kind`）的出口，
 * 因此这里按字节补齐的方式把它变成一条实时流：只处理以换行结尾的完整行，
 * 半行留到下一次轮询。文件还没创建时静默跳过，而不是报错。
 */
export function startJournalTailer(options: JournalTailerOptions): JournalTailer {
  const { path, onRecord } = options;
  let seenLines = 0;
  let stopped = false;

  const flush = (): void => {
    if (stopped) return;
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return;
    }
    if (text.length === 0) return;
    // split 的最后一个元素要么是 ""（以换行结尾），要么是尚未写完的半行。
    const complete = text.split("\n").slice(0, -1);
    for (let index = seenLines; index < complete.length; index += 1) {
      const line = complete[index];
      if (line === undefined) continue;
      const record = parseJournalRecord(line);
      if (record !== undefined) onRecord(record);
    }
    seenLines = complete.length;
  };

  const timer = setInterval(flush, options.intervalMs ?? 20);
  timer.unref();

  return {
    flush,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/**
 * 从 journal 尾部反向找出最后一条 `waiting` 工具结果。
 *
 * 审批等待**不写** `state.pendingUserInput`（那个字段只管澄清），所以进程重启后
 * 唯一还能说明"它在等什么"的地方就是这条 JSONL 记录。读到不完整/损坏的行直接跳过。
 */
export function readLastWaitingRequest(
  path: string,
): { requestId: string; reason: string } | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }

  const lines = text.split("\n").filter((line) => line.length > 0);
  const start = Math.max(0, lines.length - WAITING_SCAN_MAX_LINES);
  for (let index = lines.length - 1; index >= start; index -= 1) {
    const line = lines[index];
    if (line === undefined) continue;
    const record = parseJournalRecord(line);
    if (record === undefined) continue;
    const waiting = record["waiting"];
    if (typeof waiting !== "object" || waiting === null) continue;
    const requestId = (waiting as Record<string, unknown>)["requestId"];
    if (typeof requestId !== "string" || requestId.length === 0) continue;
    const reason = (waiting as Record<string, unknown>)["reason"];
    return { requestId, reason: typeof reason === "string" ? reason : "" };
  }
  return undefined;
}
