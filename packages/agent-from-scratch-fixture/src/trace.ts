export interface TraceEvent {
  runId: string;
  sequence: number;
  type: string;
  startedAt: string;
  durationMs?: number | undefined;
  model?: string | undefined;
  toolName?: string | undefined;
  inputBytes?: number | undefined;
  outputBytes?: number | undefined;
  outcome: "started" | "passed" | "failed" | "blocked";
  errorCode?: string | undefined;
}

export interface TraceSink {
  record(event: Omit<TraceEvent, "sequence">): void;
  readRun(runId: string): TraceEvent[];
}

/**
 * 运行累计用量。
 *
 * **token 字段是 `number | undefined`，`undefined` 表示未知**（provider 没有返回该字段），
 * 而不是 0：用假造的数字掩盖"这次调用到底烧了多少 token 我们不知道"比缺失更糟。
 * 未知会沿 `addUsage` 传播——"部分调用没有 usage"的运行因此如实显示 `in=unknown`。
 * `modelCalls` / `toolCalls` / `durationMs` 由 Harness 自己计数，永远已知。
 */
export interface RunUsage {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cachedInputTokens?: number | undefined;
  modelCalls: number;
  toolCalls: number;
  durationMs: number;
  estimatedCostUsd?: number | undefined;
}

/** 累计器的起点：还没有任何调用发生，因此是**已知的 0**，不是未知。 */
export function emptyUsage(): RunUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    modelCalls: 0,
    toolCalls: 0,
    durationMs: 0,
  };
}

/** 未知即未知：任何一侧缺失都让合计保持 `undefined`，绝不当 0 相加。 */
export function addOptionalCounts(
  left: number | undefined,
  right: number | undefined,
): number | undefined {
  if (left === undefined || right === undefined) return undefined;
  return left + right;
}

export function addUsage(left: RunUsage, right: RunUsage): RunUsage {
  const total: RunUsage = {
    inputTokens: addOptionalCounts(left.inputTokens, right.inputTokens),
    outputTokens: addOptionalCounts(left.outputTokens, right.outputTokens),
    cachedInputTokens: addOptionalCounts(left.cachedInputTokens, right.cachedInputTokens),
    modelCalls: left.modelCalls + right.modelCalls,
    toolCalls: left.toolCalls + right.toolCalls,
    durationMs: left.durationMs + right.durationMs,
  };
  if (left.estimatedCostUsd !== undefined || right.estimatedCostUsd !== undefined) {
    total.estimatedCostUsd = (left.estimatedCostUsd ?? 0) + (right.estimatedCostUsd ?? 0);
  }
  return total;
}

/** 输出层统一口径：`undefined` 打印成 `unknown`，而不是 `0`。 */
export function formatUsageNumber(value: number | undefined): string {
  return value === undefined ? "unknown" : String(value);
}

/** 同步内存 sink：Loop 先写 Trace，再通知终端 UI。 */
export class InMemoryTraceSink implements TraceSink {
  private readonly events: TraceEvent[] = [];

  record(event: Omit<TraceEvent, "sequence">): void {
    const sequence = this.events.filter((item) => item.runId === event.runId).length + 1;
    this.events.push(structuredClone({ ...event, sequence }));
  }

  readRun(runId: string): TraceEvent[] {
    return this.events
      .filter((event) => event.runId === runId)
      .toSorted((left, right) => left.sequence - right.sequence)
      .map((event) => structuredClone(event));
  }

  all(): TraceEvent[] {
    return this.events.map((event) => structuredClone(event));
  }
}
