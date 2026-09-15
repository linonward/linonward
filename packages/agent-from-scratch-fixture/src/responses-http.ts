import type {
  Model,
  ModelResponseContentPart,
  ModelUsage,
  NormalizedModelResponse,
  ResponsesClientLike,
} from "./model.js";
import { parseModelUsage } from "./model.js";

/**
 * DeepSeek 的 Responses API 与 OpenAI 的 Responses API 名称相同，但语义不同：
 *
 * - **无状态**：`previous_response_id` / `conversation` / `store` 都不支持，
 *   请求里带上也会被**静默忽略**。多轮历史必须由客户端在 `input` 里重新发送。
 * - **不支持 `truncation`**：超出上下文窗口直接返回 `400`，不会截断。
 * - `tools` 只支持扁平的 `function`（`{type, name, description, parameters}`）与内建 `web_search`；
 *   `strict` 未见文档支持，发送前必须剥掉（见 `responses-stateless-driver.ts`）。
 * - 响应没有顶层 `output_text` 字段，只有 `output` 数组；文本要从
 *   `message.content[].output_text` 里聚合（OpenAI SDK 的便捷字段是 SDK 自己加的）。
 */
export const DEEPSEEK_DEFAULTS = {
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-v4-flash",
} as const;

export interface DeepSeekConfig {
  apiKey: string;
  baseUrl: string;
  /** 循环（多轮工具调用）使用的模型。 */
  model: string;
  /**
   * 规划器使用的模型。规划只做短 JSON 输出，通常可以用更强/更省的不同型号；
   * `DEEPSEEK_PLANNER_MODEL` 缺省回落到 `model`。
   */
  plannerModel: string;
}

/** 只从环境变量解析；缺 key 时抛出可读错误，且**绝不回显 key 的值**。 */
export function resolveDeepSeekConfig(env: NodeJS.ProcessEnv = process.env): DeepSeekConfig {
  const apiKey = env["DEEPSEEK_API_KEY"];
  if (!apiKey) {
    throw new Error(
      "缺少 DEEPSEEK_API_KEY：请通过环境变量或调用方注入，代码不会读取任何内置密钥。",
    );
  }

  const baseUrl = env["DEEPSEEK_BASE_URL"] ?? DEEPSEEK_DEFAULTS.baseUrl;
  const model = env["DEEPSEEK_MODEL"] ?? DEEPSEEK_DEFAULTS.model;
  // 规划模型与循环模型解耦：只设 `DEEPSEEK_MODEL` 时两者一致，行为与之前相同。
  const plannerModel = env["DEEPSEEK_PLANNER_MODEL"] ?? model;
  return { apiKey, baseUrl, model, plannerModel };
}

/**
 * 归一化后的输出 item。
 *
 * 形状与 `ResponsesResultLike["output"][number]` 逐字段一致（`exactOptionalPropertyTypes`
 * 下不能给可选字段加 `| undefined`），因此结果可以直接喂给现有 `toModelTurn`。
 * `content` 只存在于 `message` item 上，读取时要先做属性存在性检查。
 */
export interface ResponseOutputItem {
  type: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: readonly ResponseContentPart[];
}

/**
 * `message` item 的 `output_text` 与 `reasoning` item 的 `reasoning_text` 共用这个分片形状。
 * 直接复用 `model.ts` 的定义，避免归一化层与 `toModelTurn` 对同一份 provider 形状各写一遍。
 */
export type ResponseContentPart = ModelResponseContentPart;

/**
 * 归一化结果：`id` 保留、`output` 原样映射、`output_text` 从 message 块聚合、
 * `usage` 用 `parseModelUsage` 宽松解析（缺字段就是缺失，不伪造 0）。
 */
export type ResponseResult = NormalizedModelResponse;

export interface ResponsesHttpOptions {
  apiKey: string;
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
  /** 附带的额外重试次数（首次尝试不计）。默认 2。 */
  maxRetries?: number | undefined;
}

export const DEFAULT_RESPONSES_TIMEOUT_MS = 60_000;
export const DEFAULT_RESPONSES_MAX_RETRIES = 2;
/** 指数退避基数；实际睡眠为 `RETRY_BASE_DELAY_MS * 2^retry`（每次尝试翻倍）。 */
export const RETRY_BASE_DELAY_MS = 250;
/** 单次退避上限，避免 `Retry-After` 或计数过大把测试拖死。 */
export const MAX_RETRY_DELAY_MS = 5_000;
/** 错误信息里附带的响应体上限，避免把整页 HTML 塞进日志。 */
export const ERROR_BODY_LIMIT = 2_000;

/** 带状态码与响应体的传输错误：调用方可以按 `status` 分流，不必解析字符串。 */
export class ResponsesHttpError extends Error {
  readonly status: number;
  readonly body: string;
  readonly retryAfterMs: number | undefined;

  constructor(status: number, body: string, message: string, retryAfterMs?: number | undefined) {
    super(message);
    this.name = "ResponsesHttpError";
    this.status = status;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
  }
}

export interface ResponsesHttpBody {
  model: string;
  instructions?: string;
  input?: unknown;
  tools?: readonly unknown[];
  tool_choice?: string;
}

export interface ResponsesHttpClient {
  responses: {
    create(body: ResponsesHttpBody): Promise<ResponseResult>;
  };
}

function appendPath(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOutputItem(value: unknown): value is ResponseOutputItem {
  return isRecord(value) && typeof value["type"] === "string";
}

function isContentPart(value: unknown): value is ResponseContentPart {
  return isRecord(value);
}

function truncateErrorBody(value: string, limit = ERROR_BODY_LIMIT): string {
  return value.length > limit ? `${value.slice(0, limit)}…(truncated)` : value;
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    return truncateErrorBody(await response.text());
  } catch {
    return "";
  }
}

async function decodeJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 只有 `message.content[].output_text` 计入聚合文本；缺失时为 `""`。 */
function aggregateOutputText(output: readonly ResponseOutputItem[]): string {
  const parts: string[] = [];

  for (const item of output) {
    if (item.type !== "message") continue;
    const content = Object.hasOwn(item, "content") ? item.content : undefined;
    if (!Array.isArray(content)) continue;

    for (const rawPart of content) {
      if (!isContentPart(rawPart)) continue;
      if (rawPart.type !== "output_text") continue;
      if (typeof rawPart.text !== "string") continue;
      parts.push(rawPart.text);
    }
  }

  return parts.join("");
}

/** 缺 `id` / `output` 时给出安全默认值，而不是让调用方解构崩掉。 */
function normalizeResult(value: unknown): ResponseResult {
  if (!isRecord(value)) {
    throw new ResponsesHttpError(200, "", "Responses API 返回了非对象 JSON");
  }

  const outputValue = value["output"];
  const output: ResponseOutputItem[] = Array.isArray(outputValue)
    ? outputValue.filter(isOutputItem)
    : [];

  const result: ResponseResult = {
    id: typeof value["id"] === "string" ? value["id"] : "",
    output,
    output_text: aggregateOutputText(output),
  };
  // provider 没给 usage（或只给了无法识别的形状）时不写这个字段：缺失就是缺失。
  const usage = parseModelUsage(value["usage"]);
  if (usage !== undefined) result.usage = usage;
  return result;
}

function parseRetryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(seconds * 1_000, MAX_RETRY_DELAY_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * `POST {baseUrl}/responses` + 超时 + 有界指数退避重试 + 响应归一化。
 *
 * 重试只针对 429、5xx 与网络错误；其它 4xx 立刻抛出带状态码与响应体的
 * `ResponsesHttpError`。`fetchImpl` 可注入，离线测试因此不需要网络。
 */
export function createResponsesHttpClient(options: ResponsesHttpOptions): ResponsesHttpClient {
  if (!options.apiKey) {
    throw new Error("createResponsesHttpClient 需要 apiKey，且不会记录或回显该值。");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_RESPONSES_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_RESPONSES_MAX_RETRIES;
  const url = appendPath(options.baseUrl ?? DEEPSEEK_DEFAULTS.baseUrl, "/responses");

  const attempt = async (body: ResponsesHttpBody): Promise<ResponseResult> => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!response.ok) {
      const errorBody = await readErrorBody(response);
      throw new ResponsesHttpError(
        response.status,
        errorBody,
        `DeepSeek Responses API 请求失败：HTTP ${response.status}${
          errorBody ? ` ${errorBody}` : ""
        }`,
        parseRetryAfterMs(response),
      );
    }

    return normalizeResult(await decodeJson(response));
  };

  return {
    responses: {
      async create(body) {
        for (let retry = 0; ; retry += 1) {
          try {
            // 不发送 `previous_response_id` / `store` / `parallel_tool_calls`：
            // DeepSeek 不支持这些字段，发了也只会被静默忽略。
            return await attempt(body);
          } catch (error) {
            const httpError = error instanceof ResponsesHttpError ? error : undefined;
            // 没有状态码意味着网络层错误（连接重置、超时中止等），同样值得重试。
            const retryable =
              httpError === undefined ? true : httpError.status === 429 || httpError.status >= 500;

            if (!retryable || retry >= maxRetries) {
              if (httpError) throw httpError;
              throw new ResponsesHttpError(
                0,
                "",
                `DeepSeek Responses API 请求失败：${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }

            await sleep(httpError?.retryAfterMs ?? RETRY_BASE_DELAY_MS * 2 ** retry);
          }
        }
      },
    },
  };
}

/**
 * 供 Planner 使用：一次 `generate` 就是一次无状态请求，返回聚合文本。
 *
 * `Model.generate` 的契约只返回 `string`，因此归一化后的 `usage` 通过 `onUsage`
 * 回调**带出来**（未提供时行为与不采集 usage 时逐字节一致）；没有 usage 时回调收到
 * `undefined`，调用方必须记 `unknown` 而不是 0。
 */
export function createResponsesModel(options: {
  client: ResponsesClientLike;
  modelId: string;
  onUsage?: ((usage: ModelUsage | undefined) => void) | undefined;
}): Model {
  const { client, modelId, onUsage } = options;

  return {
    async generate(request) {
      const response = await client.responses.create({
        model: modelId,
        instructions: request.instructions,
        input: request.input,
      });
      onUsage?.(response.usage);
      return response.output_text;
    },
  };
}
