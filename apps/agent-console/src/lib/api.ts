/**
 * 浏览器侧的 API 客户端。
 *
 * 只发相对路径（`/api/...`），开发时由 Vite 代理到本地 API 服务；生产构建下由
 * 使用者自行把静态文件与 API 放在同一个源上。**任何密钥都不经过浏览器**：表单里
 * 没有密钥字段，响应里也不会有。
 */

import { isPlainObject, type JournalRecord, parseJournalRecord } from "./journal.js";
import {
  parseRunSnapshot,
  parseRunSummaries,
  type RunSnapshotView,
  type RunSummaryView,
} from "./snapshot.js";

/** 浏览器侧保存访问令牌的键：只放在 sessionStorage，关掉标签页就没了。 */
export const TOKEN_STORAGE_KEY = "agentConsoleToken";

/** 读出已保存的令牌（没有 sessionStorage 时返回 undefined，便于 SSR / 测试）。 */
export function readStoredToken(): string | undefined {
  try {
    const value = globalThis.sessionStorage?.getItem(TOKEN_STORAGE_KEY)?.trim();
    return value === undefined || value.length === 0 ? undefined : value;
  } catch {
    return undefined;
  }
}

export function storeToken(token: string | undefined): void {
  try {
    if (token === undefined || token.trim().length === 0) {
      globalThis.sessionStorage?.removeItem(TOKEN_STORAGE_KEY);
      return;
    }
    globalThis.sessionStorage?.setItem(TOKEN_STORAGE_KEY, token.trim());
  } catch {
    // 隐私模式等场景下 sessionStorage 不可用：不因此让界面崩掉。
  }
}

/**
 * 建立会话：把令牌换成 HttpOnly cookie。
 *
 * 浏览器侧 `EventSource` 不能自定义请求头，所以"每个请求都带 Authorization"这条路走不通——
 * 拿 cookie 之后，SSE 也会自动带上。返回 `required: false` 表示服务端根本没配令牌。
 */
export async function startSession(token: string | undefined): Promise<{ required: boolean }> {
  const response = await fetch("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(token === undefined ? {} : { token }),
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  const body: unknown = await response.json();
  const required = isPlainObject(body) && body["required"] === true;
  return { required };
}

export interface RunFormValues {
  task: string;
  cwd: string;
  allowedArgv: string[][];
  maxSteps: number;
  maxToolCalls: number;
  /** 花费上限（美元）：留空即不限制。 */
  maxCostUsd?: number | undefined;
  /** 墙钟上限（毫秒）：留空即不限制。 */
  maxWallMs?: number | undefined;
  approveAllowed: boolean;
  requireSandbox: boolean;
  repeatGuard: boolean;
  plannerModel: string;
}

export interface StreamHandlers {
  /** `seq` 是该记录在服务端频道里的序号，用作重连时的 `after`。 */
  onRecord(record: JournalRecord, seq: number): void;
  onDone(): void;
  onError(message: string): void;
}

async function errorMessage(response: Response): Promise<string> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (typeof body === "object" && body !== null) {
    const message = (body as Record<string, unknown>)["error"];
    if (typeof message === "string" && message.length > 0) return message;
  }
  return `请求失败：HTTP ${response.status}`;
}

async function postJson(path: string, payload: unknown): Promise<JournalRecord> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  const body: unknown = await response.json();
  if (!isPlainObject(body)) throw new Error("服务端返回了非对象 JSON");
  return body;
}

export async function startRun(values: RunFormValues): Promise<{ runId: string }> {
  const body = await postJson("/api/run", {
    task: values.task,
    cwd: values.cwd,
    allowedArgv: values.allowedArgv,
    maxSteps: values.maxSteps,
    maxToolCalls: values.maxToolCalls,
    maxCostUsd: values.maxCostUsd,
    maxWallMs: values.maxWallMs,
    approveAllowed: values.approveAllowed,
    requireSandbox: values.requireSandbox,
    repeatGuard: values.repeatGuard,
    plannerModel: values.plannerModel.trim().length === 0 ? undefined : values.plannerModel.trim(),
  });
  const runId = body["runId"];
  if (typeof runId !== "string" || runId.length === 0) {
    throw new Error("服务端没有返回 runId");
  }
  return { runId };
}

export async function sendAnswer(runId: string, requestId: string, text: string): Promise<void> {
  await postJson(`/api/runs/${encodeURIComponent(runId)}/answer`, { requestId, text });
}

/** 中止正在执行的运行：abort 会传到模型调用与工具（含整个进程组）。 */
export async function cancelRun(runId: string): Promise<void> {
  await postJson(`/api/runs/${encodeURIComponent(runId)}/cancel`, {});
}

/**
 * 读 checkpoint 快照。**404 返回 `undefined`**（没有这个运行的检查点），
 * 其它错误抛出——界面对"没有"和"拿不到"要给出不同的说法。
 */
export async function fetchSnapshot(runId: string): Promise<RunSnapshotView | undefined> {
  const response = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(await errorMessage(response));
  return parseRunSnapshot(await response.json());
}

/** 最近的运行列表（读磁盘 checkpoint，API 进程重启后依然可用）。 */
export async function listRuns(): Promise<RunSummaryView[]> {
  const response = await fetch("/api/runs");
  if (!response.ok) throw new Error(await errorMessage(response));
  return parseRunSummaries(await response.json());
}

/**
 * 订阅一次运行的 journal 流。
 *
 * `after` 是已经收到的记录条数：服务端按序补发后续记录，重连（例如审批后继续运行）
 * 因此不会重复渲染历史。返回的函数用于主动断开。
 */
export function openRunStream(runId: string, after: number, handlers: StreamHandlers): () => void {
  const source = new EventSource(
    `/api/runs/${encodeURIComponent(runId)}/stream?after=${Math.max(0, after)}`,
  );
  let closed = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    source.close();
  };

  source.addEventListener("journal", (event) => {
    if (!(event instanceof MessageEvent)) return;
    const record = parseJournalRecord(event.data);
    const seq = Number.parseInt(event.lastEventId, 10);
    if (record !== undefined) handlers.onRecord(record, Number.isFinite(seq) ? seq : 0);
  });

  source.addEventListener("done", () => {
    close();
    handlers.onDone();
  });

  source.addEventListener("error", () => {
    if (closed) return;
    close();
    handlers.onError("实时流已断开：请确认本地 API 服务仍在运行");
  });

  return close;
}
