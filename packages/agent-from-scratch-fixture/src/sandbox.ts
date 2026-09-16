import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";

/**
 * 进程隔离（第 09 章"权限与安全"里 `PolicyContext.network` 之外的 OS 级边界）。
 *
 * 教程的立场是：**策略声明不等于隔离**。`PolicyContext.network === "disabled"` 只会让
 * 策略层拒绝 `run_command` 之外的网络/外部副作用工具，它不会给已经放行的子进程禁网。
 * 真正禁止网络、把写入限制在工作区内，必须依赖容器或 OS sandbox。
 *
 * 这个模块给出**可选、可注入、失败即拒绝**的参考实现：
 * - 不提供隔离时显式使用 `noSandbox`（`id: "none"`，不提供任何保证）；
 * - 需要隔离时要么真的包装 argv，要么抛 `SandboxError` 拒绝执行 —— 绝不静默降级。
 */

export type SandboxGuarantee = "network-isolation" | "filesystem-write-confinement";

export interface SandboxPolicy {
  /** 复用 `PolicyContext.network`：`disabled` 表示这次运行声明不需要网络。 */
  network: "disabled" | "enabled";
  /** 工作区根：只有它（以及系统临时目录）允许写入。 */
  writableRoot: string;
}

export interface SandboxCommand {
  command: string;
  args: string[];
  /** 子进程的初始工作目录。bubblewrap 需要显式 `--chdir`；seatbelt 由父进程 cwd 继承。 */
  cwd?: string | undefined;
}

export interface Sandbox {
  /** `"none"` | `"macos-seatbelt"` | `"linux-bubblewrap"` | ... */
  readonly id: string;
  /** 这个实现**能够**提供哪些保证；是否真的满足某条策略由 `wrap` 决定。 */
  readonly guarantees: readonly SandboxGuarantee[];
  isAvailable(): Promise<boolean>;
  /** 返回真正要 spawn 的 argv（把平台包装器前置）。不可用/无法满足策略时**必须抛错**。 */
  wrap(input: SandboxCommand, policy: SandboxPolicy): Promise<{ command: string; args: string[] }>;
}

export type SandboxErrorCode = "sandbox_unavailable" | "sandbox_network_isolation_unsupported";

/** 沙箱门禁失败。`code` 会被 `execute-tool.ts` 折成结构化 observation。 */
export class SandboxError extends Error {
  readonly code: SandboxErrorCode;

  constructor(code: SandboxErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "SandboxError";
    this.code = code;
  }
}

export const MACOS_SEATBELT_EXECUTABLE = "/usr/bin/sandbox-exec";

/** SBPL 字符串字面量的转义：反斜杠与双引号必须转义，换行必须消除（否则可注入新规则）。 */
function seatbeltLiteral(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r");
}

/** 允许写入的目录：工作区 + 系统临时目录。读取不在限制范围内。 */
export function seatbeltWritableRoots(policy: SandboxPolicy): string[] {
  return [policy.writableRoot, "/private/tmp", "/tmp", "/private/var/folders"];
}

/** 允许写入的设备文件；拒绝它们会让子进程连标准输出都写不出去。 */
export const SEATBELT_WRITABLE_DEVICES: readonly string[] = [
  "/dev/null",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/zero",
];

/**
 * 纯函数：生成 macOS seatbelt profile。
 *
 * SBPL 的规则后写覆盖先写，所以顺序是"先全量 deny、再逐条 allow 例外"：
 * `(allow default)` 放开读取与进程执行，`(deny network*)` 按策略禁网，
 * `(deny file-write*)` 之后只把 `seatbeltWritableRoots` 与 `SEATBELT_WRITABLE_DEVICES`
 * 里的路径重新允许写入。
 */
export function buildSeatbeltProfile(policy: SandboxPolicy): string {
  const rules: string[] = ["(version 1)", "(allow default)"];

  if (policy.network === "disabled") rules.push("(deny network*)");

  const writable = [
    ...seatbeltWritableRoots(policy).map((path) => `  (subpath "${seatbeltLiteral(path)}")`),
    ...SEATBELT_WRITABLE_DEVICES.map((path) => `  (literal "${seatbeltLiteral(path)}")`),
  ].join("\n");

  rules.push("(deny file-write*)");
  rules.push(`(allow file-write*\n${writable})`);

  return rules.join("\n");
}

export const macOsSeatbeltSandbox: Sandbox = {
  id: "macos-seatbelt",
  guarantees: ["network-isolation", "filesystem-write-confinement"],
  isAvailable: () => isExecutable(MACOS_SEATBELT_EXECUTABLE),
  async wrap(input, policy) {
    return {
      command: MACOS_SEATBELT_EXECUTABLE,
      args: ["-p", buildSeatbeltProfile(policy), input.command, ...input.args],
    };
  },
};

/**
 * 纯函数：生成 bubblewrap argv。
 *
 * `/` 以只读挂载，工作区再以读写 bind 覆盖；`--unshare-net` 只在策略禁用网络时出现。
 * `--chdir` 指向子进程真实工作目录（缺省回落到工作区根），最后用 `--` 与命令分隔，
 * 因此路径里的空格/引号不经过任何 shell，无需转义。
 */
export function buildBubblewrapArgs(input: SandboxCommand, policy: SandboxPolicy): string[] {
  const args: string[] = ["--die-with-parent"];

  if (policy.network === "disabled") args.push("--unshare-net");

  args.push("--ro-bind", "/", "/");
  args.push("--bind", policy.writableRoot, policy.writableRoot);
  args.push("--dev", "/dev");
  args.push("--proc", "/proc");
  args.push("--chdir", input.cwd ?? policy.writableRoot);
  args.push("--", input.command, ...input.args);

  return args;
}

export const linuxBubblewrapSandbox: Sandbox = {
  id: "linux-bubblewrap",
  guarantees: ["network-isolation", "filesystem-write-confinement"],
  async isAvailable() {
    return (await findExecutable("bwrap")) !== undefined;
  },
  async wrap(input, policy) {
    return { command: "bwrap", args: buildBubblewrapArgs(input, policy) };
  },
};

/** 容器沙箱的环境变量：`AGENT_SANDBOX=docker` 或直接给镜像名。 */
export const SANDBOX_KIND_ENV = "AGENT_SANDBOX";
export const SANDBOX_IMAGE_ENV = "AGENT_SANDBOX_IMAGE";
export const DOCKER_SANDBOX_DEFAULT_IMAGE = "node:24-bookworm-slim";
export const DOCKER_SANDBOX_DEFAULT_MEMORY = "2g";
export const DOCKER_SANDBOX_DEFAULT_CPUS = "2";
export const DOCKER_SANDBOX_DEFAULT_PIDS = 512;

export interface DockerSandboxOptions {
  image?: string | undefined;
  memory?: string | undefined;
  cpus?: string | undefined;
  pidsLimit?: number | undefined;
  /** 只读根下的可写临时目录大小。 */
  tmpfsSize?: string | undefined;
  /** 探测 docker 是否可用；离线测试注入替身，默认真的去跑 `docker version`。 */
  isDockerAvailable?: (() => Promise<boolean>) | undefined;
}

/**
 * 纯函数：生成 `docker run` argv。
 *
 * 这是把"策略声明"变成"内核级事实"的一层：`--network none` 才是真的没网，
 * `--read-only` + `-v workspace:rw` 才是真的只能写工作区，`--cap-drop ALL` +
 * `no-new-privileges` 才让容器里的进程没法提权。配额（内存 / CPU / pids）是另一件事：
 * 没有它，一条命令就能把宿主机拖垮。
 *
 * 命令与参数原样接在镜像之后，不经过任何 shell 拼接。
 */
export function buildDockerArgs(
  input: SandboxCommand,
  policy: SandboxPolicy,
  options: DockerSandboxOptions = {},
): string[] {
  const image = options.image ?? DOCKER_SANDBOX_DEFAULT_IMAGE;
  const cwd = input.cwd ?? policy.writableRoot;
  const args: string[] = [
    "run",
    "--rm",
    "--init",
    "--network",
    policy.network === "disabled" ? "none" : "bridge",
    "--memory",
    options.memory ?? DOCKER_SANDBOX_DEFAULT_MEMORY,
    "--cpus",
    options.cpus ?? DOCKER_SANDBOX_DEFAULT_CPUS,
    "--pids-limit",
    String(options.pidsLimit ?? DOCKER_SANDBOX_DEFAULT_PIDS),
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--tmpfs",
    `/tmp:rw,noexec,nosuid,size=${options.tmpfsSize ?? "256m"}`,
  ];

  // 以宿主 uid/gid 运行：否则容器里写出来的文件属于 root，工作区会被搞得没法用。
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid !== undefined && gid !== undefined) args.push("--user", `${uid}:${gid}`);

  args.push("-v", `${policy.writableRoot}:${policy.writableRoot}:rw`, "-w", cwd);
  args.push(image, input.command, ...input.args);
  return args;
}

async function dockerAvailable(): Promise<boolean> {
  const { execFile } = await import("node:child_process");
  return await new Promise<boolean>((resolve) => {
    execFile(
      "docker",
      ["version", "--format", "{{.Server.Version}}"],
      { timeout: 5_000 },
      (error) => resolve(error === null),
    );
  });
}

/**
 * 容器沙箱：把命令交给 `docker run`，用挂载与内核配额把副作用限制在工作区里。
 *
 * 它比 seatbelt / bubblewrap 更适合生产：镜像固定了工具链，配额由内核保证，
 * 而且在 Linux 服务器与 CI 里都一致——不像 seatbelt 只在 macOS、bwrap 只在装了
 * bubblewrap 的 Linux 上可用。
 */
export function createDockerSandbox(options: DockerSandboxOptions = {}): Sandbox {
  return {
    id: "docker",
    guarantees: ["network-isolation", "filesystem-write-confinement"],
    isAvailable: options.isDockerAvailable ?? dockerAvailable,
    async wrap(input, policy) {
      return { command: "docker", args: buildDockerArgs(input, policy, options) };
    },
  };
}

export const dockerSandbox: Sandbox = createDockerSandbox();

/**
 * `noSandbox` **不提供任何隔离**：命令以当前用户的全部权限运行，
 * 只适用于已经可信的任务（例如仓库自己的测试）。需要执行不可信代码时，
 * 必须换成真沙箱或容器，并把 `requireSandbox` 打开。
 */
export const noSandbox: Sandbox = {
  id: "none",
  guarantees: [],
  async isAvailable() {
    return true;
  },
  async wrap(input) {
    return { command: input.command, args: [...input.args] };
  },
};

/**
 * 选择实现；**这里不探测可用性**，`isAvailable()` 由调用方 await。
 *
 * 优先级：`AGENT_SANDBOX` 显式指定 > `AGENT_SANDBOX_IMAGE`（给了镜像就是要容器）>
 * 平台默认。无法识别的取值不猜，回落到平台默认。
 */
export function detectSandbox(
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Sandbox {
  const requested = env[SANDBOX_KIND_ENV]?.trim();
  if (requested === "docker") return dockerSandbox;
  if (requested === "none") return noSandbox;
  if (requested === "seatbelt") return macOsSeatbeltSandbox;
  if (requested === "bubblewrap") return linuxBubblewrapSandbox;

  const image = env[SANDBOX_IMAGE_ENV]?.trim();
  if (image !== undefined && image.length > 0) return createDockerSandbox({ image });

  if (platform === "darwin") return macOsSeatbeltSandbox;
  if (platform === "linux") return linuxBubblewrapSandbox;
  return noSandbox;
}

export interface SandboxGateOptions {
  sandbox?: Sandbox | undefined;
  /** 调用方显式要求隔离。默认 `false`：未注入或 `noSandbox` 时保持无沙箱行为。 */
  requireSandbox?: boolean | undefined;
  policy: SandboxPolicy;
}

/**
 * 执行前的沙箱门禁：**要么返回真正要 spawn 的 argv，要么抛错**。
 *
 * - 没有注入沙箱且未要求隔离 → 原样返回（与今天一致）；
 * - 注入了 `id !== "none"` 的沙箱但不可用 → `sandbox_unavailable`（不退回无隔离执行）；
 * - `requireSandbox: true` 但没有可用隔离 → `sandbox_unavailable`；
 * - 策略声明 `network: "disabled"` 而沙箱不提供 `network-isolation` → 拒绝。
 */
export async function wrapWithSandbox(
  input: SandboxCommand,
  options: SandboxGateOptions,
): Promise<{ command: string; args: string[] }> {
  const sandbox = options.sandbox;

  if (sandbox === undefined) {
    if (options.requireSandbox === true) {
      throw new SandboxError(
        "sandbox_unavailable",
        "requireSandbox 已开启，但没有注入任何 Sandbox",
      );
    }
    return { command: input.command, args: [...input.args] };
  }

  if (sandbox.id === "none") {
    if (options.requireSandbox === true) {
      throw new SandboxError(
        "sandbox_unavailable",
        'requireSandbox 已开启，但当前沙箱是 "none"（不提供任何隔离）',
      );
    }
    return { command: input.command, args: [...input.args] };
  }

  // `id !== "none"` 就意味着调用方想要真隔离：不可用只能拒绝，不能静默降级。
  if (!(await sandbox.isAvailable())) {
    throw new SandboxError("sandbox_unavailable", `沙箱 "${sandbox.id}" 在当前环境不可用`);
  }

  if (options.policy.network === "disabled" && !sandbox.guarantees.includes("network-isolation")) {
    throw new SandboxError(
      "sandbox_network_isolation_unsupported",
      `策略声明 network=disabled，但沙箱 "${sandbox.id}" 不提供 network-isolation`,
    );
  }

  return sandbox.wrap(input, options.policy);
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function findExecutable(name: string): Promise<string | undefined> {
  const directories = (process.env["PATH"] ?? "")
    .split(delimiter)
    .filter((directory) => directory.length > 0);

  for (const directory of directories) {
    const candidate = join(directory, name);
    if (await isExecutable(candidate)) return candidate;
  }

  return undefined;
}
