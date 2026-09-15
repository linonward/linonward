import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runAgentLoop, type AgentLoopEvent, type AgentLoopOptions } from "./agent-loop.js";
import { canonicalJson } from "./checkpoint.js";
import { applyUserAnswer } from "./interaction.js";
import type { ModelDriver } from "./model.js";
import type { Planner } from "./planner.js";
import type { ApprovalLedger, PolicyContext } from "./policy.js";
import type { Sandbox } from "./sandbox.js";
import {
  fromDurableState,
  loopOptionsFromRuntime,
  resumeAgentRun,
  restoreRun,
  toDurableState,
  type AgentRuntime,
} from "./recovery.js";
import { createRunCheckpoint, type RunStore } from "./run-store.js";
import { createInitialState } from "./state.js";
import { InMemoryWriteLease, type WriteLease } from "./tool.js";
import type { ToolRegistry } from "./tool-registry.js";
import { InMemoryTraceSink, type TraceSink } from "./trace.js";
import type { AgentResult, Clock, UserInputAnswer, ValidationSpec } from "./types.js";

export {
  MACOS_SEATBELT_EXECUTABLE,
  SandboxError,
  SEATBELT_WRITABLE_DEVICES,
  buildBubblewrapArgs,
  buildSeatbeltProfile,
  detectSandbox,
  linuxBubblewrapSandbox,
  macOsSeatbeltSandbox,
  noSandbox,
  seatbeltWritableRoots,
  wrapWithSandbox,
} from "./sandbox.js";
export type {
  Sandbox,
  SandboxCommand,
  SandboxErrorCode,
  SandboxGateOptions,
  SandboxGuarantee,
  SandboxPolicy,
} from "./sandbox.js";

export type CliCommand =
  | { command: "run"; task: string }
  | { command: "resume"; runId: string }
  | { command: "answer"; runId: string; requestId: string; content: string };

export const EXIT_CODES = {
  completed: 0,
  failed: 1,
  usage: 2,
  waiting: 3,
  cancelled: 130,
} as const;

export const CLI_USAGE =
  "usage: agent run <task> | agent resume <run-id> | agent answer <run-id> <request-id> <text>";

/** CLI 只解析参数；装配、信号与退出码都在 `runCli` 内完成。 */
export function parseCliArgs(argv: string[]): CliCommand {
  const [command, ...rest] = argv;

  if (command === "run") {
    const task = rest.join(" ").trim();
    if (!task) throw new Error(CLI_USAGE);
    return { command: "run", task };
  }

  if (command === "resume") {
    const runId = rest[0];
    if (!runId || rest.length !== 1) throw new Error(CLI_USAGE);
    return { command: "resume", runId };
  }

  if (command === "answer") {
    const [runId, requestId, ...content] = rest;
    const text = content.join(" ").trim();
    if (!runId || !requestId || !text) throw new Error(CLI_USAGE);
    return { command: "answer", runId, requestId, content: text };
  }

  throw new Error(CLI_USAGE);
}

export function exitCodeFor(result: AgentResult): number {
  if (result.status === "completed") return EXIT_CODES.completed;
  if (result.status === "waiting") return EXIT_CODES.waiting;
  if (result.status === "cancelled") return EXIT_CODES.cancelled;
  return EXIT_CODES.failed;
}

/** 注入式 CLI 运行时：测试传入替身，生产代码由 `createAgentCliRuntime` 装配。 */
export interface CliRuntime {
  run(task: string): Promise<AgentResult>;
  resume(runId: string): Promise<AgentResult>;
  answer(runId: string, answer: UserInputAnswer): Promise<AgentResult>;
}

export interface CliRuntimeInput {
  cwd: string;
  skillsDirectory: string;
  signal: AbortSignal;
  onEvent: (event: AgentLoopEvent) => void;
}

export interface CliDependencies {
  createRuntime(input: CliRuntimeInput): CliRuntime;
}

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

/**
 * `run` 启动新运行，`resume` 从 checkpoint 续跑，`answer` 先落盘回答再续跑。
 * 退出码区分完成、失败、用法错误、等待输入与取消。
 */
export async function runCli(
  argv: string[],
  dependencies: CliDependencies,
  io: CliIo,
): Promise<number> {
  let parsed: CliCommand;
  try {
    parsed = parseCliArgs(argv);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return EXIT_CODES.usage;
  }

  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  const cwd = process.cwd();

  try {
    const runtime = dependencies.createRuntime({
      cwd,
      skillsDirectory: resolve(cwd, "skills"),
      signal: controller.signal,
      onEvent: (event) => io.stderr(canonicalJson(event)),
    });

    let result: AgentResult;
    if (parsed.command === "run") {
      result = await runtime.run(parsed.task);
    } else if (parsed.command === "resume") {
      result = await runtime.resume(parsed.runId);
    } else {
      result = await runtime.answer(parsed.runId, {
        requestId: parsed.requestId,
        content: parsed.content,
        receivedAt: new Date().toISOString(),
      });
    }

    io.stdout(result.answer);
    io.stderr(
      canonicalJson({
        runId: result.state.runId,
        status: result.status,
        stopReason: result.stopReason,
        changedFiles: result.state.changedFiles,
        mutationRevision: result.state.mutationRevision,
      }),
    );
    return exitCodeFor(result);
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

export interface AgentCliOptions {
  cwd: string;
  skillsDirectory: string;
  store: RunStore;
  model: ModelDriver;
  planner: Planner;
  tools: ToolRegistry;
  trace?: TraceSink | undefined;
  clock?: Clock | undefined;
  policy?: PolicyContext | undefined;
  approvals?: ApprovalLedger | undefined;
  writeLease?: WriteLease | undefined;
  /** 可选注入的进程沙箱；缺省时 CLI 链路不包装 `run_command`。 */
  sandbox?: Sandbox | undefined;
  /** 显式要求隔离：`true` 时没有可用沙箱就拒绝执行。 */
  requireSandbox?: boolean | undefined;
  validationSpecs?: ValidationSpec[] | undefined;
  maxSteps?: number | undefined;
  maxToolCalls?: number | undefined;
}

export function createAgentRuntime(base: AgentCliOptions, input: CliRuntimeInput): AgentRuntime {
  return {
    model: base.model,
    planner: base.planner,
    tools: base.tools,
    trace: base.trace ?? new InMemoryTraceSink(),
    store: base.store,
    clock: base.clock ?? { now: () => new Date() },
    skillsDirectory: input.skillsDirectory,
    toolTimeoutMs: 60_000,
    policy: base.policy,
    approvals: base.approvals,
    writeLease: base.writeLease ?? new InMemoryWriteLease(),
    sandbox: base.sandbox,
    requireSandbox: base.requireSandbox,
    validationSpecs: base.validationSpecs,
    signal: input.signal,
    onEvent: input.onEvent,
  };
}

function optionsFor(
  state: ReturnType<typeof createInitialState>,
  runtime: AgentRuntime,
): AgentLoopOptions {
  return loopOptionsFromRuntime(state, runtime);
}

/** 生产装配：模型驱动、计划器与工具注册表都由调用方注入，CLI 只负责编排。 */
export function createAgentCliRuntime(
  options: AgentCliOptions,
): (input: CliRuntimeInput) => CliRuntime {
  return (input) => {
    const runtime = createAgentRuntime(options, input);

    return {
      async run(task) {
        const state = createInitialState(task, options.cwd, {
          maxSteps: options.maxSteps ?? 12,
          maxToolCalls: options.maxToolCalls ?? 24,
        });
        return runAgentLoop(task, optionsFor(state, runtime));
      },
      async resume(runId) {
        return resumeAgentRun(runId, runtime);
      },
      async answer(runId, answer) {
        const restored = await restoreRun({
          runId,
          ownerId: randomUUID(),
          store: options.store,
        });
        const now = runtime.clock.now();
        const resumed = applyUserAnswer(fromDurableState(restored.state), answer, now);

        await options.store.append({
          runId,
          expectedSequence: restored.state.nextEventSequence,
          ownerId: restored.lease.ownerId,
          epoch: restored.lease.epoch,
          event: {
            type: "user_input_received",
            requestId: answer.requestId,
            content: answer.content,
          },
          now,
        });

        const durable = toDurableState(resumed, restored.state.providerCursor);
        await options.store.saveCheckpoint(
          createRunCheckpoint({
            state: { ...durable, nextEventSequence: restored.state.nextEventSequence + 1 },
            throughSequence: restored.state.nextEventSequence,
            now,
          }),
          restored.lease,
        );

        return resumeAgentRun(runId, runtime);
      },
    };
  };
}

/**
 * 该 fixture 永远不访问网络：`main` 只负责装配 store 与信号，
 * 真实模型驱动必须由嵌入方通过 `createAgentCliRuntime` 注入。
 */
async function main(): Promise<void> {
  process.stderr.write(
    [
      "agent-from-scratch fixture 离线运行入口。",
      "请通过 createAgentCliRuntime 注入 ModelDriver / Planner / ToolRegistry，",
      CLI_USAGE,
    ].join("\n") + "\n",
  );
  process.exitCode = EXIT_CODES.usage;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  await main();
}
