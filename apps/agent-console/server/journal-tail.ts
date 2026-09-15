import { readFileSync } from "node:fs";

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
