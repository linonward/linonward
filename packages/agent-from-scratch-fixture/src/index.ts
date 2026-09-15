import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { type AgentLoopEvent, runAgentLoop } from "./agent-loop.js";
import { canonicalJson } from "./checkpoint.js";
import { createVerboseObserver } from "./cli-verbose.js";
import { applyUserAnswer } from "./interaction.js";
import type { ModelDriver } from "./model.js";
import type { Planner } from "./planner.js";
import type { ApprovalLedger, PolicyContext } from "./policy.js";
import {
  type AgentRuntime,
  fromDurableState,
  loopOptionsFromRuntime,
  restoreRun,
  resumeAgentRun,
  toDurableState,
} from "./recovery.js";
import { createRunCheckpoint, type RunStore } from "./run-store.js";
import type { Sandbox } from "./sandbox.js";
import { createInitialState } from "./state.js";
import { InMemoryWriteLease, type WriteLease } from "./tool.js";
import type { ToolRegistry } from "./tool-registry.js";
import { InMemoryTraceSink, type TraceSink } from "./trace.js";
import type { AgentResult, Clock, UserInputAnswer, ValidationSpec } from "./types.js";

export type {
  Sandbox,
  SandboxCommand,
  SandboxErrorCode,
  SandboxGateOptions,
  SandboxGuarantee,
  SandboxPolicy,
} from "./sandbox.js";
export {
  buildBubblewrapArgs,
  buildSeatbeltProfile,
  detectSandbox,
  linuxBubblewrapSandbox,
  MACOS_SEATBELT_EXECUTABLE,
  macOsSeatbeltSandbox,
  noSandbox,
  SandboxError,
  SEATBELT_WRITABLE_DEVICES,
  seatbeltWritableRoots,
  wrapWithSandbox,
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

/** `--verbose` 是纯输出开关：只影响 stderr 上的额外详情，不改变控制流与退出码。 */
export interface CliRunOptions {
  /**
   * 打开详细输出：stderr 上额外打印每个 Loop 事件一行、工具观测的有界摘要
   * 与运行结束汇总。stdout 始终只放最终答案，管道因此保持可用。
   */
  verbose?: boolean | undefined;
}

/**
 * `run` 启动新运行，`resume` 从 checkpoint 续跑，`answer` 先落盘回答再续跑。
 * 退出码区分完成、失败、用法错误、等待输入与取消。
 */
export async function runCli(
  argv: string[],
  dependencies: CliDependencies,
  io: CliIo,
  options: CliRunOptions = {},
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
  // 关闭时连观察者都不创建：默认路径没有额外订阅，也没有额外计算。
  const observer =
    options.verbose === true ? createVerboseObserver((line) => io.stderr(line)) : undefined;

  try {
    const runtime = dependencies.createRuntime({
      cwd,
      skillsDirectory: resolve(cwd, "skills"),
      signal: controller.signal,
      onEvent: (event) => {
        io.stderr(canonicalJson(event));
        observer?.onEvent(event);
      },
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
    observer?.finish(result);
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

/** CLI 进程是短命的：每次 `run` / `resume` / `answer` 都取一次 lease，结束后立即释放。 */
export const CLI_LEASE_TTL_MS = 10 * 60 * 1_000;

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
        const lease = await options.store.acquireLease(state.runId, randomUUID(), CLI_LEASE_TTL_MS);

        try {
          // `runId` 必须显式传给 Loop：否则 `runAgentLoop` 会另生成一个 runId，
          // 拿到的 lease 与真正持久化的 run 就对不上，`resume` 永远找不到它。
          return await runAgentLoop(task, {
            ...loopOptionsFromRuntime(state, runtime, lease),
            runId: state.runId,
          });
        } finally {
          await options.store.releaseLease(lease);
        }
      },
      async resume(runId) {
        return resumeAgentRun(runId, runtime, { releaseLeaseOnReturn: true });
      },
      async answer(runId, answer) {
        const restored = await restoreRun({
          runId,
          ownerId: randomUUID(),
          store: options.store,
        });

        try {
          const now = runtime.clock.now();
          const resumed = applyUserAnswer(fromDurableState(restored.state), answer, now);
          // store 的序号由 store 自己决定：内存日志含 `step_started` 等运行时事件，
          // 两个计数器并不共用，用 `state.nextEventSequence` 会被拒绝为 unexpected_sequence。
          const persisted = await options.store.readEvents(runId, 0);
          const record = await options.store.append({
            runId,
            expectedSequence: (persisted.at(-1)?.sequence ?? 0) + 1,
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
              state: { ...durable, nextEventSequence: resumed.nextEventSequence },
              throughSequence: record.sequence,
              now,
            }),
            restored.lease,
          );
        } finally {
          // 回答已经落盘；随后交给 `resumeAgentRun` 重新取 lease 续跑。
          await options.store.releaseLease(restored.lease);
        }

        return resumeAgentRun(runId, runtime, { releaseLeaseOnReturn: true });
      },
    };
  };
}

/**
 * 直接执行 `src/index.ts` 时的兜底提示。可执行入口是 `scripts/agent.ts`（`pnpm agent`），
 * 它装配真实 DeepSeek Responses 驱动；这里的 `main` 只说明如何自行注入另一种驱动。
 */
async function main(): Promise<void> {
  process.stderr.write(
    [
      "agent-from-scratch fixture：可执行入口是 `pnpm agent`（见 scripts/agent.ts）。",
      "如需注入其它 ModelDriver / Planner / ToolRegistry，请使用 createAgentCliRuntime。",
      CLI_USAGE,
    ].join("\n") + "\n",
  );
  process.exitCode = EXIT_CODES.usage;
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  await main();
}
