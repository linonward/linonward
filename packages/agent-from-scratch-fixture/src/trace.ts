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

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  modelCalls: number;
  toolCalls: number;
  durationMs: number;
  estimatedCostUsd?: number | undefined;
}

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

export function addUsage(left: RunUsage, right: RunUsage): RunUsage {
  const total: RunUsage = {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    modelCalls: left.modelCalls + right.modelCalls,
    toolCalls: left.toolCalls + right.toolCalls,
    durationMs: left.durationMs + right.durationMs,
  };
  if (left.estimatedCostUsd !== undefined || right.estimatedCostUsd !== undefined) {
    total.estimatedCostUsd = (left.estimatedCostUsd ?? 0) + (right.estimatedCostUsd ?? 0);
  }
  return total;
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
