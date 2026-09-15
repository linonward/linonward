import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { LoopPricing } from "./agent-loop.js";
import { createJournal, createJournalModelDriver, createJournalToolHook } from "./cli-journal.js";
import {
  type AgentCliOptions,
  type CliCommand,
  type CliDependencies,
  type CliIo,
  type CliRuntime,
  type CliRuntimeInput,
  createAgentCliRuntime,
  EXIT_CODES,
  parseCliArgs,
  runCli,
} from "./index.js";
import type { ModelDriver } from "./model.js";
import type { Planner } from "./planner.js";
import { createModelPlanner } from "./planner-model.js";
import type { PolicyContext } from "./policy.js";
import { resolvePriceTable } from "./pricing.js";
import {
  createResponsesHttpClient,
  createResponsesModel,
  type DeepSeekConfig,
  resolveDeepSeekConfig,
} from "./responses-http.js";
import { createStatelessResponsesDriver } from "./responses-stateless-driver.js";
import { LocalFileRunStore, type RunStore } from "./run-store.js";
import {
  createRealTaskRegistry,
  PreApprovingLedger,
  REAL_TASK_DEFAULT_MAX_STEPS,
  REAL_TASK_DEFAULT_MAX_TOOL_CALLS,
  REAL_TASK_DEFAULT_PLANNER_MAX_OBSERVATIONS,
} from "./run-task.js";
import { detectSandbox } from "./sandbox.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { Clock } from "./types.js";

export const AGENT_USAGE =
  "usage: agent run <task> | agent resume <run-id> | agent answer <run-id> <request-id> <text> [--cwd <dir>] [--allow <command> [args...]] [--require-sandbox] [--approve-allowed] [--max-steps <n>] [--max-tool-calls <n>] [--verbose] [--log <path>] [--no-truncate]";

/** 与 `runRealTask` 保持同一组预算默认值：CLI 与真实通路不各自定义一套。 */
export const AGENT_DEFAULT_MAX_STEPS = REAL_TASK_DEFAULT_MAX_STEPS;
export const AGENT_DEFAULT_MAX_TOOL_CALLS = REAL_TASK_DEFAULT_MAX_TOOL_CALLS;

const ALLOW_FLAG = "--allow";
const CWD_FLAG = "--cwd";
const REQUIRE_SANDBOX_FLAG = "--require-sandbox";
const APPROVE_ALLOWED_FLAG = "--approve-allowed";
const MAX_STEPS_FLAG = "--max-steps";
const MAX_TOOL_CALLS_FLAG = "--max-tool-calls";
const VERBOSE_FLAG = "--verbose";
const LOG_FLAG = "--log";
const NO_TRUNCATE_FLAG = "--no-truncate";

/** `--allow` 收集 argv 时遇到这些开关就停：它们属于 CLI，不属于被允许的命令。 */
const KNOWN_FLAGS: ReadonlySet<string> = new Set([
  ALLOW_FLAG,
  CWD_FLAG,
  REQUIRE_SANDBOX_FLAG,
  APPROVE_ALLOWED_FLAG,
  MAX_STEPS_FLAG,
  MAX_TOOL_CALLS_FLAG,
  VERBOSE_FLAG,
  LOG_FLAG,
  NO_TRUNCATE_FLAG,
]);

function usageError(detail: string): Error {
  return new Error(`${AGENT_USAGE}\n${detail}`);
}

function positiveInteger(flag: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw usageError(`${flag} 需要一个正整数，收到：${value}`);
  }
  return parsed;
}

export interface AgentCliConfig {
  cwd: string;
  allowedArgv: string[][];
  requireSandbox: boolean;
  autoApproveAllowedCommands: boolean;
  maxSteps: number;
  maxToolCalls: number;
  /** 默认关闭：打开后只在 stderr 上追加有界详情，stdout 仍只有最终答案。 */
  verbose: boolean;
  /** `--log <path>`：把同一条完整日志以 JSONL 追加写入文件。只在 `--verbose` 打开时生效。 */
  logPath?: string | undefined;
  /** `--no-truncate`：关闭单条内容 20000 字符上限。只在 `--verbose` 打开时生效。 */
  noTruncate: boolean;
}

/**
 * 把 `agent` 的 argv 拆成"运行时配置"与"子命令"。
 *
 * 子命令仍交给 `parseCliArgs` 解析（保持与既有 CLI 契约一致）；这里只负责把
 * `--cwd` / `--allow` / `--require-sandbox` / `--approve-allowed` / `--max-steps` /
 * `--max-tool-calls` / `--verbose` / `--log` / `--no-truncate` 从位置参数里摘出来。
 * `--allow` 每次吞掉一个完整 argv，直到下一个已识别的 CLI flag 为止，因此可以重复出现。
 *
 * 布尔开关（`--require-sandbox` / `--approve-allowed` / `--verbose` / `--no-truncate`）
 * 只看"出现过"，放在子命令前或后都一样，重复出现也不报错。
 */
export function parseAgentArgs(argv: string[]): { config: AgentCliConfig; command: CliCommand } {
  const positionals: string[] = [];
  const allowedArgv: string[][] = [];
  let cwd: string | undefined;
  let requireSandbox = false;
  let autoApproveAllowedCommands = false;
  let maxSteps = AGENT_DEFAULT_MAX_STEPS;
  let maxToolCalls = AGENT_DEFAULT_MAX_TOOL_CALLS;
  let verbose = false;
  let logPath: string | undefined;
  let noTruncate = false;

  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    index += 1;
    if (token === undefined) continue;

    if (token === ALLOW_FLAG) {
      const allowed: string[] = [];
      while (index < argv.length) {
        const candidate = argv[index];
        if (candidate === undefined || KNOWN_FLAGS.has(candidate)) break;
        allowed.push(candidate);
        index += 1;
      }
      if (allowed.length === 0) throw usageError(`${ALLOW_FLAG} 需要一个完整命令 argv`);
      allowedArgv.push(allowed);
      continue;
    }

    if (token === CWD_FLAG) {
      const value = argv[index];
      if (value === undefined || KNOWN_FLAGS.has(value)) {
        throw usageError(`${CWD_FLAG} 需要一个目录`);
      }
      index += 1;
      cwd = resolve(value);
      continue;
    }

    if (token === MAX_STEPS_FLAG || token === MAX_TOOL_CALLS_FLAG) {
      const value = argv[index];
      if (value === undefined || KNOWN_FLAGS.has(value)) {
        throw usageError(`${token} 需要一个正整数`);
      }
      index += 1;
      const parsed = positiveInteger(token, value);
      if (token === MAX_STEPS_FLAG) maxSteps = parsed;
      else maxToolCalls = parsed;
      continue;
    }

    if (token === REQUIRE_SANDBOX_FLAG) {
      requireSandbox = true;
      continue;
    }

    if (token === APPROVE_ALLOWED_FLAG) {
      autoApproveAllowedCommands = true;
      continue;
    }

    if (token === VERBOSE_FLAG) {
      verbose = true;
      continue;
    }

    if (token === LOG_FLAG) {
      const value = argv[index];
      if (value === undefined || KNOWN_FLAGS.has(value)) {
        throw usageError(`${LOG_FLAG} 需要一个文件路径`);
      }
      index += 1;
      logPath = resolve(value);
      continue;
    }

    if (token === NO_TRUNCATE_FLAG) {
      noTruncate = true;
      continue;
    }

    if (token.startsWith("--")) throw usageError(`未知参数：${token}`);
    positionals.push(token);
  }

  let command: CliCommand;
  try {
    command = parseCliArgs(positionals);
  } catch (error) {
    throw usageError(error instanceof Error ? error.message : String(error));
  }

  return {
    config: {
      cwd: cwd ?? process.cwd(),
      allowedArgv,
      requireSandbox,
      autoApproveAllowedCommands,
      maxSteps,
      maxToolCalls,
      verbose,
      logPath,
      noTruncate,
    },
    command,
  };
}

/** 缺 key 的错误只给指引，**绝不**回显任何 key 值。 */
export const AGENT_MISSING_KEY_MESSAGE = [
  "缺少 DEEPSEEK_API_KEY：真实 DeepSeek Responses 通路需要密钥，代码不会读取内置密钥。",
  "复制 packages/agent-from-scratch-fixture/.env.example 为 packages/agent-from-scratch-fixture/.env 并填入真实 key，",
  "或用 DEEPSEEK_API_KEY=... pnpm agent ...（CLI 通过 node --env-file-if-exists=.env 自动加载 .env）。",
].join("\n");

function requireDeepSeekConfig(env: NodeJS.ProcessEnv): DeepSeekConfig {
  const apiKey = env["DEEPSEEK_API_KEY"];
  if (!apiKey) throw new Error(AGENT_MISSING_KEY_MESSAGE);
  return resolveDeepSeekConfig(env);
}

/** 循环模型用 `config.model`，规划模型用 `config.plannerModel`，共用同一个 HTTP 客户端。 */
function createRealModels(config: DeepSeekConfig): { model: ModelDriver; planner: Planner } {
  const client = createResponsesHttpClient({ apiKey: config.apiKey, baseUrl: config.baseUrl });
  return {
    model: createStatelessResponsesDriver({ client, modelId: config.model }),
    planner: createModelPlanner(createResponsesModel({ client, modelId: config.plannerModel }), {
      maxObservations: REAL_TASK_DEFAULT_PLANNER_MAX_OBSERVATIONS,
    }),
  };
}

function resolveModels(
  deps: AgentCliDeps,
  env: NodeJS.ProcessEnv,
): { model: ModelDriver; planner: Planner; modelId?: string | undefined } {
  if (deps.model !== undefined && deps.planner !== undefined) {
    // 注入替身时模型 id 只能由调用方给出：没有 id 就没有成本估算（`cost=unknown`）。
    return { model: deps.model, planner: deps.planner, modelId: deps.modelId };
  }
  const config = requireDeepSeekConfig(env);
  const real = createRealModels(config);
  return {
    model: deps.model ?? real.model,
    planner: deps.planner ?? real.planner,
    modelId: deps.modelId ?? config.model,
  };
}

/**
 * 运行存根根目录。`resume` / `answer` 是独立进程，必须落在稳定路径上；
 * 覆盖方式：`AGENT_STORE_ROOT` 环境变量或注入 `deps.store`。
 */
function defaultStoreRoot(env: NodeJS.ProcessEnv): string {
  const configured = env["AGENT_STORE_ROOT"];
  return configured !== undefined && configured.length > 0
    ? configured
    : join(tmpdir(), "linonward-agent-runs");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toCliArgv(command: CliCommand): string[] {
  if (command.command === "run") return ["run", command.task];
  if (command.command === "resume") return ["resume", command.runId];
  return ["answer", command.runId, command.requestId, command.content];
}

export interface AgentCliDeps {
  model?: ModelDriver | undefined;
  planner?: Planner | undefined;
  tools?: ToolRegistry | undefined;
  store?: RunStore | undefined;
  storeRoot?: string | undefined;
  clock?: Clock | undefined;
  /**
   * 注入替身时用于日志与成本估算的模型 id。真实通路自动取 `DEEPSEEK_MODEL`；
   * 缺省时 `[usage]` 行显示 `model=unknown` / `cost=unknown`。
   */
  modelId?: string | undefined;
  /** 完全替换运行时装配（含 store）；提供时不再解析 DeepSeek 配置。 */
  runtime?: ((input: CliRuntimeInput) => CliRuntime) | undefined;
}

export interface DeepSeekAgentCliOptions {
  env?: NodeJS.ProcessEnv | undefined;
  stdout?: ((text: string) => void) | undefined;
  stderr?: ((text: string) => void) | undefined;
  io?: CliIo | undefined;
  deps?: AgentCliDeps | undefined;
}

interface RealWiring {
  model: ModelDriver;
  planner: Planner;
  tools: ToolRegistry;
  store: RunStore;
  /** 真实通路解析出的模型 id（只用于日志，**不含密钥**）；注入替身时为 undefined。 */
  modelId?: string | undefined;
  /** 成本估算接线：模型 id + 价目表（内置表或被环境变量覆盖的表）。 */
  pricing: LoopPricing;
}

function createRuntimeFactory(
  wiring: RealWiring & {
    config: AgentCliConfig;
    clock?: Clock | undefined;
    skillsDirectory: string;
  },
): (input: CliRuntimeInput) => CliRuntime {
  const approvals = new PreApprovingLedger();
  if (wiring.config.autoApproveAllowedCommands) approvals.allowPolicyApprovedCommands();

  const policy: PolicyContext = {
    cwd: wiring.config.cwd,
    realWorkspaceRoot: wiring.config.cwd,
    allowedArgv: wiring.config.allowedArgv,
    network: "disabled",
  };

  return (input) => {
    const options: AgentCliOptions = {
      cwd: wiring.config.cwd,
      skillsDirectory: wiring.skillsDirectory,
      store: wiring.store,
      model: wiring.model,
      planner: wiring.planner,
      tools: wiring.tools,
      policy,
      approvals,
      sandbox: detectSandbox(),
      requireSandbox: wiring.config.requireSandbox,
      maxSteps: wiring.config.maxSteps,
      maxToolCalls: wiring.config.maxToolCalls,
      pricing: wiring.pricing,
    };
    if (wiring.clock !== undefined) options.clock = wiring.clock;
    if (input.journal !== undefined) options.onToolCall = createJournalToolHook(input.journal);

    return createAgentCliRuntime(options)({ ...input, skillsDirectory: wiring.skillsDirectory });
  };
}

function buildDependencies(input: {
  config: AgentCliConfig;
  runtimeOverride: ((runtimeInput: CliRuntimeInput) => CliRuntime) | undefined;
  wiring: RealWiring | undefined;
  clock: Clock | undefined;
  skillsDirectory: string;
}): CliDependencies {
  const { runtimeOverride, wiring } = input;
  if (runtimeOverride !== undefined) return { createRuntime: runtimeOverride };
  if (wiring === undefined) throw new Error("internal: missing runtime wiring");
  return {
    createRuntime: createRuntimeFactory({
      config: input.config,
      model: wiring.model,
      planner: wiring.planner,
      tools: wiring.tools,
      store: wiring.store,
      pricing: wiring.pricing,
      clock: input.clock,
      skillsDirectory: input.skillsDirectory,
    }),
  };
}

/**
 * 装配真实运行并返回可直接执行的 argv 处理器。
 *
 * 真实模型是 `createStatelessResponsesDriver`（循环）+ `createModelPlanner`
 * （规划，读 `config.plannerModel`）；工具、沙箱、策略与持久化走既有装配。
 * `deps` 允许测试注入替身，此时不会解析密钥、也不会访问网络。
 */
export async function createDeepSeekAgentCli(
  options: DeepSeekAgentCliOptions = {},
): Promise<(argv: string[]) => Promise<number>> {
  const env = options.env ?? process.env;
  const deps = options.deps ?? {};
  const io: CliIo = options.io ?? {
    stdout: options.stdout ?? ((text: string) => process.stdout.write(`${text}\n`)),
    stderr: options.stderr ?? ((text: string) => process.stderr.write(`${text}\n`)),
  };
  const skillsDirectory = resolve(import.meta.dirname, "..", "skills");
  const runtimeOverride = deps.runtime;

  // 真实驱动是**惰性**装配的：`pnpm agent`（只有用法错误）不应该因为缺 key 而先失败，
  // 只有真的要执行 `run` / `resume` / `answer` 时才解析密钥。缺 key 的异常直接冒泡，
  // 由 `scripts/agent.ts` 打印并以 EXIT_CODES.usage 结束。
  let wiring: RealWiring | undefined;

  const resolveWiring = (): RealWiring => {
    if (wiring !== undefined) return wiring;
    const models = resolveModels(deps, env);
    wiring = {
      ...models,
      // 价格表在装配期解析：`DEEPSEEK_PRICE_TABLE(_JSON)` 写错时**立刻**报可读错误，
      // 而不是静默退回内置表、让操作者以为成本是按自己的内部价算的。
      pricing: { modelId: models.modelId, table: resolvePriceTable(env) },
      tools: deps.tools ?? createRealTaskRegistry(),
      store: deps.store ?? new LocalFileRunStore(deps.storeRoot ?? defaultStoreRoot(env)),
    };
    return wiring;
  };

  return async (argv: string[]): Promise<number> => {
    let parsed: { config: AgentCliConfig; command: CliCommand };
    try {
      parsed = parseAgentArgs(argv);
    } catch (error) {
      io.stderr(messageOf(error));
      return EXIT_CODES.usage;
    }

    // 缺 key 的异常必须直接冒泡（由 scripts/agent.ts 打印），因此 wiring 先于 journal 解析。
    const realWiring = runtimeOverride === undefined ? resolveWiring() : undefined;

    const journal = createJournal({
      verbose: parsed.config.verbose,
      logPath: parsed.config.logPath,
      truncate: !parsed.config.noTruncate,
      write: (line) => io.stderr(line),
    });

    try {
      journal.runMeta({
        command: parsed.command.command,
        task: parsed.command.command === "run" ? parsed.command.task : undefined,
        cwd: parsed.config.cwd,
        budgets: { maxSteps: parsed.config.maxSteps, maxToolCalls: parsed.config.maxToolCalls },
        allowedArgv: parsed.config.allowedArgv,
        requireSandbox: parsed.config.requireSandbox,
        modelId: realWiring?.modelId,
      });

      // 只在日志打开时装饰驱动；关闭时不创建 journal，也不改变模型边界。
      const wiring =
        realWiring !== undefined && journal.active
          ? {
              ...realWiring,
              model: createJournalModelDriver(realWiring.model, journal, realWiring.pricing),
            }
          : realWiring;

      const dependencies = buildDependencies({
        config: parsed.config,
        runtimeOverride,
        wiring,
        clock: deps.clock,
        skillsDirectory,
      });

      try {
        return await runCli(toCliArgv(parsed.command), dependencies, io, {
          verbose: parsed.config.verbose,
          journal,
          pricing: realWiring?.pricing,
        });
      } catch (error) {
        // 运行期错误（未知 requestId、没有可恢复的检查点等）折成可读错误与非零退出码。
        io.stderr(messageOf(error));
        return EXIT_CODES.failed;
      }
    } finally {
      journal.close();
    }
  };
}
