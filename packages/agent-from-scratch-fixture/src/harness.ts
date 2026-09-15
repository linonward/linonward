import type { ContextSource, ModelRequest } from "./context.js";
import { buildModelRequest } from "./context.js";
import type { Model } from "./model.js";
import { appendEvent, canTransition, createInitialState, transitionState } from "./state.js";
import type { AgentResult, AgentState, Clock, StopReason } from "./types.js";

export interface HarnessOptions {
  cwd: string;
  maxSteps: number;
  model: Model;
  clock?: Clock | undefined;
  signal?: AbortSignal | undefined;
  onEvent?: ((event: RuntimeEvent) => void) | undefined;
}

export type RuntimeEvent =
  | { type: "run_started"; runId: string }
  | { type: "model_started"; step: number }
  | { type: "model_completed"; step: number }
  | { type: "run_stopped"; reason: StopReason };

/**
 * 最小 Agent Loop（第 03 章）。它不接受工具调用，只验证
 * 可观察、可取消、有停止条件且可测试的控制流。
 * 完整循环见 `agent-loop.ts`。
 */
export async function runMinimalAgent(task: string, options: HarnessOptions): Promise<AgentResult> {
  let state = createInitialState(
    task,
    options.cwd,
    { maxSteps: options.maxSteps, maxToolCalls: 0 },
    { now: options.clock?.now() ?? new Date() },
  );
  const emit = (event: RuntimeEvent): void => {
    options.onEvent?.(event);
  };

  emit({ type: "run_started", runId: state.runId });

  const stop = (reason: StopReason): AgentResult => {
    const status: AgentState["status"] = reason === "cancelled" ? "cancelled" : "failed";
    const stopped = canTransition(state.status, status)
      ? transitionState(state, status, reason, options.clock?.now() ?? new Date())
      : appendEvent(state, "run_stopped", reason, options.clock?.now() ?? new Date());
    state = stopped;
    emit({ type: "run_stopped", reason });
    return { status: stopped.status, answer: "", stopReason: reason, state: stopped };
  };

  for (let step = 1; step <= options.maxSteps; step += 1) {
    if (options.signal?.aborted) return stop("cancelled");

    const request: ModelRequest = buildModelRequest({
      task: state.task,
      cwd: options.cwd,
      toolNames: [],
      sources: [] as ContextSource[],
    });

    emit({ type: "model_started", step });
    state.budget.modelSteps = step;

    let answer: string;
    try {
      answer = (await options.model.generate(request)).trim();
    } catch {
      return stop(options.signal?.aborted ? "cancelled" : "model_error");
    }
    emit({ type: "model_completed", step });

    if (!answer) return stop("invalid_model_output");

    state.messages.push({ role: "assistant", content: answer });
    const completed = transitionState(
      state,
      "completed",
      "final_answer",
      options.clock?.now() ?? new Date(),
    );
    emit({ type: "run_stopped", reason: "final_answer" });
    return { status: "completed", answer, stopReason: "final_answer", state: completed };
  }

  return stop("max_steps");
}
