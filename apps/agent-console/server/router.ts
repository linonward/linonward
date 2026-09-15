import type { IncomingMessage, ServerResponse } from "node:http";
import { messageOf } from "../src/lib/format.js";
import {
  isPlainObject,
  isUnknownArray,
  type JournalRecord,
  readArray,
  readString,
} from "../src/lib/journal.js";
import type { RunHub } from "./bus.js";
import { redactAll, secretValues } from "./redact.js";
import {
  CONSOLE_DEFAULT_MAX_STEPS,
  CONSOLE_DEFAULT_MAX_TOOL_CALLS,
  type ConsoleRunner,
  RunnerError,
  type StartRunInput,
} from "./runner.js";

export const DEFAULT_API_PORT = 8787;
/** 请求体上限：本地工具，1MB 足够放下一段任务描述与白名单。 */
export const MAX_BODY_BYTES = 1_000_000;

export type RouteMatch =
  | { name: "health" }
  | { name: "start" }
  | { name: "stream"; runId: string }
  | { name: "snapshot"; runId: string }
  | { name: "answer"; runId: string };

/** 纯路由匹配：只做方法与路径的判断，方便离线单测。 */
export function matchRoute(method: string, pathname: string): RouteMatch | undefined {
  if (method === "GET" && pathname === "/api/health") return { name: "health" };
  if (method === "POST" && pathname === "/api/run") return { name: "start" };

  const match = /^\/api\/runs\/([^/]+)(\/stream|\/answer)?$/.exec(pathname);
  if (match === null) return undefined;
  const rawId = match[1];
  if (rawId === undefined) return undefined;

  let runId: string;
  try {
    runId = decodeURIComponent(rawId);
  } catch {
    return undefined;
  }

  const suffix = match[2];
  if (suffix === "/stream") return method === "GET" ? { name: "stream", runId } : undefined;
  if (suffix === "/answer") return method === "POST" ? { name: "answer", runId } : undefined;
  return method === "GET" ? { name: "snapshot", runId } : undefined;
}

function readPositiveInt(record: JournalRecord, key: string, fallback: number): number {
  const value = record[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new RunnerError(400, `${key} 需要正整数`);
  }
  return value;
}

function readOptionalBoolean(record: JournalRecord, key: string, fallback: boolean): boolean {
  const value = record[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new RunnerError(400, `${key} 需要布尔值`);
  return value;
}

/** `allowedArgv` 必须是"字符串数组的数组"：白名单按逐项相等匹配，不做任何猜测。 */
function readAllowedArgv(record: JournalRecord): string[][] {
  const raw = readArray(record, "allowedArgv");
  if (raw === undefined) return [];

  const result: string[][] = [];
  for (const entry of raw) {
    if (!isUnknownArray(entry)) throw new RunnerError(400, "allowedArgv 必须是字符串数组的数组");
    if (!entry.every((item): item is string => typeof item === "string")) {
      throw new RunnerError(400, "allowedArgv 只接受字符串");
    }
    if (entry.length > 0) result.push([...entry]);
  }
  return result;
}

/** 请求体 → 运行输入。所有非法输入都在这里变成 4xx，而不是让运行时崩掉。 */
export function parseRunInput(value: unknown, defaultCwd: string): StartRunInput {
  if (!isPlainObject(value)) throw new RunnerError(400, "请求体必须是 JSON 对象");

  const task = readString(value, "task")?.trim();
  if (task === undefined || task.length === 0) throw new RunnerError(400, "task 不能为空");

  const cwdValue = readString(value, "cwd")?.trim();
  const input: StartRunInput = {
    task,
    cwd: cwdValue === undefined || cwdValue.length === 0 ? defaultCwd : cwdValue,
    allowedArgv: readAllowedArgv(value),
    maxSteps: readPositiveInt(value, "maxSteps", CONSOLE_DEFAULT_MAX_STEPS),
    maxToolCalls: readPositiveInt(value, "maxToolCalls", CONSOLE_DEFAULT_MAX_TOOL_CALLS),
    approveAllowed: readOptionalBoolean(value, "approveAllowed", false),
    requireSandbox: readOptionalBoolean(value, "requireSandbox", false),
    repeatGuard: readOptionalBoolean(value, "repeatGuard", true),
  };

  const plannerModel = readString(value, "plannerModel")?.trim();
  if (plannerModel !== undefined && plannerModel.length > 0) input.plannerModel = plannerModel;
  return input;
}

export function parseAnswerInput(value: unknown): { requestId: string; text: string } {
  if (!isPlainObject(value)) throw new RunnerError(400, "请求体必须是 JSON 对象");

  const requestId = readString(value, "requestId")?.trim();
  if (requestId === undefined || requestId.length === 0) {
    throw new RunnerError(400, "requestId 不能为空");
  }
  const text = readString(value, "text")?.trim();
  if (text === undefined || text.length === 0) throw new RunnerError(400, "text 不能为空");

  return { requestId, text };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  response.end(payload);
}

/** 读取 JSON 请求体；超限或不是合法 JSON 都是 4xx。 */
function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    request.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) {
        request.destroy();
        reject(new RunnerError(413, "请求体过大"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (size === 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new RunnerError(400, "请求体不是合法 JSON"));
      }
    });
    request.on("error", (error: Error) => reject(error));
  });
}

/**
 * SSE：先补发 `after` 之后的全部记录，再推实时记录；`run_stopped` 之后推 `done` 并关闭。
 *
 * 每一帧都带 `id: <seq>`，客户端因此可以用 `?after=<seq>` 重连而不重复渲染。
 */
function handleStream(
  request: IncomingMessage,
  response: ServerResponse,
  hub: RunHub,
  runId: string,
  after: number,
): void {
  const channel = hub.get(runId);
  if (channel === undefined) {
    sendJson(response, 404, { error: `未知的 runId：${runId}` });
    return;
  }

  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.write(": connected\n\n");

  let unsubscribe = (): void => undefined;
  unsubscribe = channel.subscribe(after, {
    onEntry: (entry) => {
      if (response.writableEnded) return;
      response.write(`id: ${entry.seq}\nevent: journal\ndata: ${JSON.stringify(entry.record)}\n\n`);
    },
    onDone: () => {
      if (response.writableEnded) return;
      response.write("event: done\ndata: {}\n\n");
      response.end();
    },
  });

  request.on("close", () => {
    unsubscribe();
  });
}

export interface RouterOptions {
  runner: ConsoleRunner;
  hub: RunHub;
  env: NodeJS.ProcessEnv;
  /** 表单没给 cwd 时的默认值（默认进程工作目录）。 */
  defaultCwd?: string | undefined;
}

function parseAfter(url: URL): number {
  const raw = url.searchParams.get("after");
  if (raw === null) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/** 组装 `node:http` 的请求处理器。依赖全部注入，测试可以给假 runner（不发真实请求）。 */
export function createRequestHandler(
  options: RouterOptions,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const secrets = secretValues(options.env);
  const defaultCwd = options.defaultCwd ?? process.cwd();
  const apiKey = options.env["DEEPSEEK_API_KEY"];

  return async (request, response) => {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const route = matchRoute(method, url.pathname);

    try {
      if (route === undefined) {
        sendJson(response, 404, { error: `未知路由：${method} ${url.pathname}` });
        return;
      }

      switch (route.name) {
        case "health": {
          sendJson(response, 200, {
            ok: true,
            apiKeyConfigured: typeof apiKey === "string" && apiKey.length > 0,
          });
          return;
        }
        case "start": {
          const body = await readJsonBody(request);
          const input = parseRunInput(body, defaultCwd);
          const started = await options.runner.start(input);
          sendJson(response, 200, { runId: started.runId });
          return;
        }
        case "stream": {
          handleStream(request, response, options.hub, route.runId, parseAfter(url));
          return;
        }
        case "snapshot": {
          const snapshot = await options.runner.snapshot(route.runId);
          if (snapshot === undefined) {
            sendJson(response, 404, { error: `没有该运行的 checkpoint：${route.runId}` });
            return;
          }
          sendJson(response, 200, snapshot);
          return;
        }
        case "answer": {
          const body = await readJsonBody(request);
          const answer = parseAnswerInput(body);
          await options.runner.answer(route.runId, answer);
          sendJson(response, 200, { ok: true });
          return;
        }
      }
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      const status = error instanceof RunnerError ? error.status : 500;
      sendJson(response, status, { error: redactAll(messageOf(error), secrets) });
    }
  };
}
