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

function readLines(path: string): string[] | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  return text.split("\n").filter((line) => line.length > 0);
}

/** `run_started`（runMeta）记录：重建一次运行需要的全部参数。 */
export interface JournalRunMetaView {
  command?: string | undefined;
  task?: string | undefined;
  cwd?: string | undefined;
  budgets?:
    | {
        maxSteps?: number | undefined;
        maxToolCalls?: number | undefined;
        maxCostUsd?: number | undefined;
        maxWallMs?: number | undefined;
      }
    | undefined;
  allowedArgv?: string[][] | undefined;
  requireSandbox?: boolean | undefined;
  approveAllowed?: boolean | undefined;
  modelId?: string | undefined;
}

function readString(value: Record<string, unknown>, key: string): string | undefined {
  const raw = value[key];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

function readBudgets(value: unknown): JournalRunMetaView["budgets"] {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const maxSteps = record["maxSteps"];
  const maxToolCalls = record["maxToolCalls"];
  const maxCostUsd = record["maxCostUsd"];
  const maxWallMs = record["maxWallMs"];
  return {
    ...(typeof maxSteps === "number" ? { maxSteps } : {}),
    ...(typeof maxToolCalls === "number" ? { maxToolCalls } : {}),
    ...(typeof maxCostUsd === "number" ? { maxCostUsd } : {}),
    ...(typeof maxWallMs === "number" ? { maxWallMs } : {}),
  };
}

function readAllowedArgv(value: unknown): string[][] | undefined {
  if (!Array.isArray(value)) return undefined;
  const parsed = value.filter(
    (entry): entry is string[] =>
      Array.isArray(entry) && entry.every((item) => typeof item === "string"),
  );
  return parsed.length === value.length ? parsed : undefined;
}

/**
 * 读回 `run_started` 记录里的运行参数。
 *
 * 它写在 journal 最前面，是 API 进程重启后唯一能说明"这次运行是怎么被启动的"的地方：
 * cwd、命令白名单、预算、是否自动批准。缺失的字段保持缺失——调用方宁可退回保守默认值，
 * 也不能凭猜测把一次运行按更宽松的策略续跑。
 */
export function readRunMeta(path: string): JournalRunMetaView | undefined {
  const lines = readLines(path);
  if (lines === undefined) return undefined;

  for (const line of lines) {
    const record = parseJournalRecord(line);
    if (record === undefined || record["kind"] !== "run_started") continue;

    const meta: JournalRunMetaView = {};
    const command = readString(record, "command");
    if (command !== undefined) meta.command = command;
    const task = readString(record, "task");
    if (task !== undefined) meta.task = task;
    const cwd = readString(record, "cwd");
    if (cwd !== undefined) meta.cwd = cwd;
    const budgets = readBudgets(record["budgets"]);
    if (budgets !== undefined) meta.budgets = budgets;
    const allowedArgv = readAllowedArgv(record["allowedArgv"]);
    if (allowedArgv !== undefined) meta.allowedArgv = allowedArgv;
    if (typeof record["requireSandbox"] === "boolean") {
      meta.requireSandbox = record["requireSandbox"];
    }
    if (typeof record["approveAllowed"] === "boolean") {
      meta.approveAllowed = record["approveAllowed"];
    }
    const modelId = readString(record, "modelId");
    if (modelId !== undefined) meta.modelId = modelId;
    return meta;
  }
  return undefined;
}

/** 等待中的审批请求：只有带完整摘要字段的记录才能被重新登记进批准账本。 */
export interface WaitingApprovalRequest {
  id: string;
  actionDigest: string;
  summary: string;
  risks: string[];
  expiresAt: string;
}

function readApprovalRequest(value: unknown): WaitingApprovalRequest | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const id = readString(record, "id");
  const actionDigest = readString(record, "actionDigest");
  const expiresAt = readString(record, "expiresAt");
  if (id === undefined || actionDigest === undefined || expiresAt === undefined) return undefined;
  return {
    id,
    actionDigest,
    summary: readString(record, "summary") ?? "",
    risks: Array.isArray(record["risks"])
      ? record["risks"].filter((entry): entry is string => typeof entry === "string")
      : [],
    expiresAt,
  };
}

export interface WaitingRequestView {
  requestId: string;
  reason: string;
  /** 策略审批才有：进程重启后靠它把 requestId 重新登记进账本。 */
  request?: WaitingApprovalRequest | undefined;
}

/**
 * 从 journal 尾部反向找出最后一条 `waiting` 工具结果。
 *
 * 审批等待**不写** `state.pendingUserInput`（那个字段只管澄清），所以进程重启后
 * 唯一还能说明"它在等什么"的地方就是这条 JSONL 记录。读到不完整/损坏的行直接跳过。
 *
 * 审批记录里还带着 `policy.request`（含 `actionDigest`）：把它一起读回来，
 * 新的进程才能对同一个 requestId 发放凭证、让重放的调用消费掉。
 */
export function readLastWaitingRequest(path: string): WaitingRequestView | undefined {
  const lines = readLines(path);
  if (lines === undefined) return undefined;

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
    const view: WaitingRequestView = {
      requestId,
      reason: typeof reason === "string" ? reason : "",
    };
    const policy = record["policy"];
    if (typeof policy === "object" && policy !== null) {
      const request = readApprovalRequest((policy as Record<string, unknown>)["request"]);
      if (request !== undefined) view.request = request;
    }
    return view;
  }
  return undefined;
}
