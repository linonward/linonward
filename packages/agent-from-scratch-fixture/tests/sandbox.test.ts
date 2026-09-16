import { afterEach, describe, expect, it } from "vitest";

import { isRecord } from "../src/checkpoint.js";
import { executeToolCall } from "../src/execute-tool.js";
import type { ToolCall } from "../src/model.js";
import type { PolicyContext } from "../src/policy.js";
import { PreApprovingLedger } from "../src/run-task.js";
import {
  buildBubblewrapArgs,
  buildDockerArgs,
  buildSeatbeltProfile,
  createDockerSandbox,
  DOCKER_SANDBOX_DEFAULT_IMAGE,
  detectSandbox,
  dockerSandbox,
  linuxBubblewrapSandbox,
  macOsSeatbeltSandbox,
  noSandbox,
  type Sandbox,
  type SandboxCommand,
  SandboxError,
  type SandboxGuarantee,
  type SandboxPolicy,
  seatbeltWritableRoots,
  wrapWithSandbox,
} from "../src/sandbox.js";
import { runCommandTool } from "../src/tools/run-command.js";
import { createRegistry, makeTempDir, removeTempDir } from "./support.js";

const DISABLED: SandboxPolicy = { network: "disabled", writableRoot: "/work space/repo" };
const ENABLED: SandboxPolicy = { ...DISABLED, network: "enabled" };

function fakeSandbox(options: {
  id?: string;
  available: boolean;
  guarantees?: readonly SandboxGuarantee[];
  calls?: SandboxCommand[];
}): Sandbox {
  return {
    id: options.id ?? "fake-sandbox",
    guarantees: options.guarantees ?? ["network-isolation", "filesystem-write-confinement"],
    async isAvailable() {
      return options.available;
    },
    async wrap(input) {
      options.calls?.push(input);
      return { command: "fake-wrapper", args: [input.command, ...input.args] };
    },
  };
}

async function expectSandboxError(
  operation: Promise<unknown>,
  code: string,
): Promise<SandboxError> {
  try {
    await operation;
    throw new Error(`expected rejection with ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(SandboxError);
    if (!(error instanceof SandboxError)) throw error;
    expect(error.code).toBe(code);
    return error;
  }
}

describe("macOS seatbelt profile", () => {
  it("denies network only when the policy disables it", () => {
    expect(buildSeatbeltProfile(DISABLED)).toContain("(deny network*)");
    expect(buildSeatbeltProfile(ENABLED)).not.toContain("(deny network*)");
  });

  it("confines writes to the writable root while keeping reads open", () => {
    const profile = buildSeatbeltProfile(DISABLED);

    expect(profile).toContain("(allow default)");
    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain('(subpath "/work space/repo")');
    expect(profile).toContain('(subpath "/private/tmp")');
    // 读取没有任何 deny：只读整个工作区是常态需求。
    expect(profile).not.toContain("file-read");
    expect(seatbeltWritableRoots(DISABLED)[0]).toBe("/work space/repo");
  });

  it("escapes quotes, backslashes and newlines so the profile cannot be broken", () => {
    const profile = buildSeatbeltProfile({
      network: "disabled",
      writableRoot: '/tmp/wo"rkspace\\evil',
    });

    expect(profile).toContain('(subpath "/tmp/wo\\"rkspace\\\\evil")');

    const injected = buildSeatbeltProfile({
      network: "disabled",
      writableRoot: '/tmp/ws"\n(allow default)',
    });
    // 注入的换行被转义，不会变成第二条顶层规则。
    expect(injected.split("\n").filter((line) => line === "(allow default)")).toHaveLength(1);
    expect(injected).toContain('(subpath "/tmp/ws\\"\\n(allow default)")');
  });

  it("wraps argv with sandbox-exec without touching the command itself", async () => {
    const wrapped = await macOsSeatbeltSandbox.wrap(
      { command: "node", args: ["--version"] },
      DISABLED,
    );

    expect(wrapped.command).toBe("/usr/bin/sandbox-exec");
    expect(wrapped.args).toEqual(["-p", buildSeatbeltProfile(DISABLED), "node", "--version"]);
  });
});

describe("linux bubblewrap arguments", () => {
  it("unshares the network only when the policy disables it", () => {
    const command: SandboxCommand = {
      command: "node",
      args: ["--version"],
      cwd: "/work space/repo/src",
    };

    expect(buildBubblewrapArgs(command, DISABLED)).toContain("--unshare-net");
    expect(buildBubblewrapArgs(command, ENABLED)).not.toContain("--unshare-net");
  });

  it("binds the workspace read-write over a read-only root and sets the cwd", () => {
    const args = buildBubblewrapArgs(
      { command: "node", args: ["-e", "1"], cwd: "/work space/repo/src" },
      DISABLED,
    );

    const rootIndex = args.indexOf("--ro-bind");
    expect(args.slice(rootIndex, rootIndex + 3)).toEqual(["--ro-bind", "/", "/"]);

    const bindIndex = args.indexOf("--bind");
    expect(args.slice(bindIndex, bindIndex + 3)).toEqual([
      "--bind",
      "/work space/repo",
      "/work space/repo",
    ]);

    const chdirIndex = args.indexOf("--chdir");
    expect(args[chdirIndex + 1]).toBe("/work space/repo/src");

    // 空格不经过 shell：命令与参数按原样跟在 `--` 之后。
    const separator = args.indexOf("--");
    expect(args.slice(separator)).toEqual(["--", "node", "-e", "1"]);
  });

  it("falls back to the writable root as cwd and wraps with bwrap", async () => {
    expect(buildBubblewrapArgs({ command: "node", args: [] }, DISABLED)).toContain(
      "/work space/repo",
    );

    const wrapped = await linuxBubblewrapSandbox.wrap(
      { command: "node", args: ["--version"] },
      DISABLED,
    );
    expect(wrapped.command).toBe("bwrap");
    expect(wrapped.args).toEqual(
      buildBubblewrapArgs({ command: "node", args: ["--version"] }, DISABLED),
    );
  });
});

describe("noSandbox", () => {
  it("provides no guarantee and returns argv unchanged", async () => {
    expect(noSandbox.id).toBe("none");
    expect(noSandbox.guarantees).toEqual([]);

    const input: SandboxCommand = { command: "node", args: ["--version"] };
    await expect(noSandbox.wrap(input, DISABLED)).resolves.toEqual(input);
  });
});

describe("detectSandbox", () => {
  it("maps platforms to implementations without probing availability", () => {
    expect(detectSandbox("darwin").id).toBe("macos-seatbelt");
    expect(detectSandbox("linux").id).toBe("linux-bubblewrap");
    expect(detectSandbox("win32").id).toBe("none");
    expect(detectSandbox("freebsd")).toBe(noSandbox);
    expect(detectSandbox("darwin")).toBe(macOsSeatbeltSandbox);
    expect(detectSandbox("linux")).toBe(linuxBubblewrapSandbox);
  });
});

describe("wrapWithSandbox gate", () => {
  it("passes argv through when no sandbox is injected and isolation is not required", async () => {
    const input: SandboxCommand = { command: "node", args: ["--version"] };

    await expect(wrapWithSandbox(input, { policy: DISABLED })).resolves.toEqual(input);
    await expect(
      wrapWithSandbox(input, { sandbox: noSandbox, requireSandbox: false, policy: DISABLED }),
    ).resolves.toEqual(input);
  });

  it("refuses when isolation is required but nothing is injected or only noSandbox is", async () => {
    const input: SandboxCommand = { command: "node", args: ["--version"] };

    await expectSandboxError(
      wrapWithSandbox(input, { requireSandbox: true, policy: DISABLED }),
      "sandbox_unavailable",
    );
    await expectSandboxError(
      wrapWithSandbox(input, { sandbox: noSandbox, requireSandbox: true, policy: DISABLED }),
      "sandbox_unavailable",
    );
  });

  it("refuses an injected-but-unavailable sandbox instead of degrading silently", async () => {
    const calls: SandboxCommand[] = [];
    const sandbox = fakeSandbox({ available: false, calls });

    await expectSandboxError(
      wrapWithSandbox({ command: "node", args: ["--version"] }, { sandbox, policy: DISABLED }),
      "sandbox_unavailable",
    );
    await expectSandboxError(
      wrapWithSandbox(
        { command: "node", args: ["--version"] },
        { sandbox, requireSandbox: true, policy: DISABLED },
      ),
      "sandbox_unavailable",
    );
    expect(calls).toEqual([]);
  });

  it("refuses a sandbox that cannot isolate the network when the policy declares it disabled", async () => {
    const calls: SandboxCommand[] = [];
    const sandbox = fakeSandbox({
      available: true,
      guarantees: ["filesystem-write-confinement"],
      calls,
    });

    await expectSandboxError(
      wrapWithSandbox({ command: "node", args: ["--version"] }, { sandbox, policy: DISABLED }),
      "sandbox_network_isolation_unsupported",
    );
    expect(calls).toEqual([]);
  });

  it("wraps with the available sandbox and forwards the policy", async () => {
    const calls: SandboxCommand[] = [];
    const sandbox = fakeSandbox({ available: true, calls });
    const input: SandboxCommand = { command: "node", args: ["--version"], cwd: "/work space/repo" };

    const wrapped = await wrapWithSandbox(input, { sandbox, policy: DISABLED });

    expect(wrapped).toEqual({ command: "fake-wrapper", args: ["node", "--version"] });
    expect(calls).toEqual([input]);
  });

  it("allows a filesystem-only sandbox when the policy does not need network isolation", async () => {
    const sandbox = fakeSandbox({ available: true, guarantees: ["filesystem-write-confinement"] });

    const wrapped = await wrapWithSandbox(
      { command: "node", args: ["--version"] },
      { sandbox, policy: ENABLED },
    );

    expect(wrapped.command).toBe("fake-wrapper");
  });
});

/**
 * 真实平台集成：只在 `SANDBOX_INTEGRATION=1` 时执行，默认（含 CI）整体 skipped。
 * 这里会真的启动 `sandbox-exec` / `bwrap`，所以绝不能进入 `pnpm check` 的默认路径。
 */
describe.skipIf(process.env["SANDBOX_INTEGRATION"] !== "1")("real platform sandbox", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => removeTempDir(directory)));
  });

  interface SandboxRun {
    sandboxId: string;
    ok: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
  }

  /**
   * 外层容器/沙箱会拦住嵌套的 `sandbox-exec` / `bwrap`
   * （典型报错 `sandbox_apply: Operation not permitted`）。
   * 那是"环境不允许跑沙箱"，不是被测行为失败：这种情况整体跳过。
   */
  const BOOTSTRAP_FAILURES = [
    "sandbox_apply",
    "Creating new namespace failed",
    "setting up uid map",
    "bwrap:",
  ];

  function isSandboxBootstrapFailure(stderr: string): boolean {
    return BOOTSTRAP_FAILURES.some((marker) => stderr.includes(marker));
  }

  async function runThroughDetectedSandbox(args: string[]): Promise<SandboxRun | undefined> {
    const sandbox = detectSandbox();
    if (sandbox.id === "none") return undefined;
    if (!(await sandbox.isAvailable())) return undefined;

    const cwd = await makeTempDir("sandbox-integration-");
    temporaryDirectories.push(cwd);

    const approvals = new PreApprovingLedger();
    approvals.allowPolicyApprovedCommands();
    const policy: PolicyContext = {
      cwd,
      realWorkspaceRoot: cwd,
      allowedArgv: [["node", ...args]],
      network: "disabled",
    };
    const toolCall: ToolCall = {
      callId: "call-1",
      name: "run_command",
      argumentsJson: JSON.stringify({ command: "node", args }),
    };

    const result = await executeToolCall({
      call: toolCall,
      registry: createRegistry(runCommandTool),
      cwd,
      timeoutMs: 30_000,
      policy,
      approvals,
      runId: "sandbox-integration",
      sandbox,
      requireSandbox: true,
    });
    if (result.type !== "observation") throw new Error(`expected an observation: ${result.type}`);

    const parsed: unknown = JSON.parse(result.output);
    if (!isRecord(parsed) || !isRecord(parsed["data"])) throw new Error("malformed observation");
    const value = parsed["data"];

    const run: SandboxRun = {
      sandboxId: sandbox.id,
      ok: result.ok,
      exitCode: Number(value["exitCode"]),
      stdout: String(value["stdout"]),
      stderr: String(value["stderr"]),
    };

    if (run.exitCode !== 0 && isSandboxBootstrapFailure(run.stderr)) return undefined;
    return run;
  }

  it("runs node --version inside the detected sandbox", async (context) => {
    const run = await runThroughDetectedSandbox(["--version"]);
    if (run === undefined) return context.skip();

    expect(run.ok, `${run.sandboxId}: ${run.stderr}`).toBe(true);
    expect(run.exitCode).toBe(0);
    expect(run.stdout.trim()).toMatch(/^v\d+/);
  });

  it("blocks outbound network when the policy declares network disabled", async (context) => {
    const script =
      "fetch('https://example.com').then(() => process.exit(0), () => process.exit(1));" +
      "setTimeout(() => process.exit(2), 5000)";
    const run = await runThroughDetectedSandbox(["-e", script]);
    if (run === undefined) return context.skip();

    // 退出码 1 是脚本的 rejection 分支：网络真的不可达，而不是命令没跑起来。
    expect(run.exitCode, `${run.sandboxId} should fail to reach the network: ${run.stderr}`).toBe(
      1,
    );
  });
});

/**
 * 容器沙箱：生产环境里 seabelt / bubblewrap 都不是随处可用（CI 容器里没有 bwrap，
 * Linux 服务器上没有 seatbelt），而"没有隔离"必须是显式选择，不能是默认。
 */
describe("docker 沙箱", () => {
  const policy: SandboxPolicy = { network: "disabled", writableRoot: "/workspace" };

  it("包装成 docker run：禁网、限配额、只读根 + 工作区挂载，argv 原样透传", () => {
    const args = buildDockerArgs(
      { command: "node", args: ["--version"], cwd: "/workspace/sub" },
      policy,
      { image: "node:24-bookworm-slim" },
    );

    expect(args.slice(0, 2)).toEqual(["run", "--rm"]);
    expect(args).toContain("none"); // --network none
    expect(args.join(" ")).toContain("--network none");
    expect(args).toContain("--read-only");
    expect(args.join(" ")).toContain("--cap-drop ALL");
    expect(args.join(" ")).toContain("--security-opt no-new-privileges");
    expect(args).toContain("--memory");
    expect(args).toContain("--cpus");
    expect(args).toContain("--pids-limit");
    // 工作区以读写挂载，其余文件系统只读。
    expect(args.join(" ")).toContain("-v /workspace:/workspace:rw");
    expect(args.join(" ")).toContain("-w /workspace/sub");
    // 镜像之后是原样的命令与参数：没有任何 shell 拼接。
    const imageIndex = args.indexOf("node:24-bookworm-slim");
    expect(args.slice(imageIndex + 1)).toEqual(["node", "--version"]);
  });

  it("策略允许网络时不加 --network none（隔离声明与实现保持一致）", () => {
    const args = buildDockerArgs(
      { command: "node", args: [] },
      { ...policy, network: "enabled" },
      {},
    );

    expect(args.join(" ")).not.toContain("--network none");
    expect(args.join(" ")).toContain("--network bridge");
  });

  it("缺省镜像有明确默认值，调用方可以覆盖", () => {
    expect(buildDockerArgs({ command: "node", args: [] }, policy, {})).toContain(
      DOCKER_SANDBOX_DEFAULT_IMAGE,
    );
    expect(buildDockerArgs({ command: "node", args: [] }, policy, { image: "alpine:3" })).toContain(
      "alpine:3",
    );
  });

  it("可用性探测：docker 不在就报不可用，门禁因此拒绝执行而不是降级", async () => {
    const missing = createDockerSandbox({ isDockerAvailable: async () => false });
    await expect(missing.isAvailable()).resolves.toBe(false);

    const present = createDockerSandbox({ isDockerAvailable: async () => true });
    await expect(present.isAvailable()).resolves.toBe(true);
    await expect(
      wrapWithSandbox(
        { command: "node", args: ["--version"], cwd: "/workspace" },
        {
          sandbox: present,
          requireSandbox: true,
          policy,
        },
      ),
    ).resolves.toMatchObject({ command: "docker" });

    await expect(
      wrapWithSandbox(
        { command: "node", args: [] },
        {
          sandbox: missing,
          requireSandbox: true,
          policy,
        },
      ),
    ).rejects.toBeInstanceOf(SandboxError);
  });

  it("两个保证都声明了：网络隔离与写入收敛", () => {
    expect(dockerSandbox.guarantees).toEqual(["network-isolation", "filesystem-write-confinement"]);
  });
});

describe("沙箱选择", () => {
  it("AGENT_SANDBOX 显式指定优先于平台默认", () => {
    expect(detectSandbox("darwin", { AGENT_SANDBOX: "docker" }).id).toBe("docker");
    expect(detectSandbox("linux", { AGENT_SANDBOX: "none" }).id).toBe("none");
    expect(detectSandbox("linux", { AGENT_SANDBOX: "seatbelt" }).id).toBe("macos-seatbelt");
    // 配了镜像也意味着"我要用容器"。
    expect(detectSandbox("darwin", { AGENT_SANDBOX_IMAGE: "alpine:3" }).id).toBe("docker");
    // 不写就按平台走。
    expect(detectSandbox("darwin", {}).id).toBe("macos-seatbelt");
    expect(detectSandbox("linux", {}).id).toBe("linux-bubblewrap");
    // 无法识别的取值不猜：回落到平台默认。
    expect(detectSandbox("linux", { AGENT_SANDBOX: "gVisor" }).id).toBe("linux-bubblewrap");
  });
});
