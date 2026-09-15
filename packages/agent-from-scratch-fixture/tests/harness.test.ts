import { spawnSync } from "node:child_process";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { isRecord } from "../src/checkpoint.js";
import {
  MAX_OBSERVATION_CHARACTERS,
  executeToolCall,
  type ToolExecutionResult,
} from "../src/execute-tool.js";
import { FakeModel } from "../src/fake-model.js";
import { runMinimalAgent } from "../src/harness.js";
import { InMemoryApprovalLedger, type PolicyContext } from "../src/policy.js";
import { PreApprovingLedger } from "../src/run-task.js";
import {
  noSandbox,
  type Sandbox,
  type SandboxCommand,
  type SandboxPolicy,
} from "../src/sandbox.js";
import { applyPatchTool } from "../src/tools/apply-patch.js";
import { readFileTool } from "../src/tools/read-file.js";
import { runCommandTool } from "../src/tools/run-command.js";
import { searchTextTool } from "../src/tools/search-text.js";
import type { ToolCall } from "../src/model.js";
import {
  createRegistry,
  echoTool,
  externalTool,
  failingTool,
  hugeTool,
  makeTempDir,
  removeTempDir,
  slowTool,
} from "./support.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => removeTempDir(directory)));
});

async function tempDir(): Promise<string> {
  const directory = await makeTempDir("agent-harness-");
  temporaryDirectories.push(directory);
  return directory;
}

function call(name: string, input: unknown, callId = "call-1"): ToolCall {
  return { callId, name, argumentsJson: JSON.stringify(input) };
}

function parse(output: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(output);
  if (!isRecord(parsed)) throw new Error("observation is not an object");
  return parsed;
}

function data(output: string): Record<string, unknown> {
  const value = parse(output)["data"];
  if (!isRecord(value)) throw new Error("observation has no data object");
  return value;
}

/** `search_text` 依赖外部 ripgrep；CI 会安装它，本地可能没有。 */
const hasRipgrep = spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0;

describe("minimal agent loop", () => {
  it("emits run_started → model_started → model_completed → run_stopped and stops with final_answer", async () => {
    const events: string[] = [];
    const result = await runMinimalAgent("解释 package.json 的作用", {
      cwd: "/workspace",
      maxSteps: 3,
      model: new FakeModel(["package.json 描述项目脚本。"]),
      onEvent: (event) => void events.push(event.type),
    });

    expect(events).toEqual(["run_started", "model_started", "model_completed", "run_stopped"]);
    expect(result.status).toBe("completed");
    expect(result.stopReason).toBe("final_answer");
    expect(result.answer).toBe("package.json 描述项目脚本。");
    expect(result.state.budget.modelSteps).toBe(1);
  });

  it("maps empty output to invalid_model_output", async () => {
    const result = await runMinimalAgent("任务", {
      cwd: "/workspace",
      maxSteps: 2,
      model: new FakeModel(["   "]),
    });

    expect(result.stopReason).toBe("invalid_model_output");
    expect(result.status).toBe("failed");
  });

  it("maps a model exception to model_error", async () => {
    const result = await runMinimalAgent("任务", {
      cwd: "/workspace",
      maxSteps: 2,
      model: new FakeModel([]),
    });

    expect(result.stopReason).toBe("model_error");
    expect(result.status).toBe("failed");
  });

  it("stops with max_steps when the budget is zero", async () => {
    const result = await runMinimalAgent("任务", {
      cwd: "/workspace",
      maxSteps: 0,
      model: new FakeModel(["不会被调用"]),
    });

    expect(result.stopReason).toBe("max_steps");
    expect(result.state.budget.modelSteps).toBe(0);
  });

  it("maps a pre-aborted signal to cancelled", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await runMinimalAgent("任务", {
      cwd: "/workspace",
      maxSteps: 3,
      model: new FakeModel(["不会被调用"]),
      signal: controller.signal,
    });

    expect(result.stopReason).toBe("cancelled");
    expect(result.status).toBe("cancelled");
  });
});

describe("tool executor boundaries", () => {
  it("returns structured observations for unknown tools, bad JSON and schema failures", async () => {
    const cwd = await tempDir();
    const registry = createRegistry(echoTool);

    const unknown = await executeToolCall({
      call: call("does_not_exist", {}),
      registry,
      cwd,
      timeoutMs: 500,
    });
    const badJson = await executeToolCall({
      call: { callId: "call-2", name: "echo", argumentsJson: "{not json" },
      registry,
      cwd,
      timeoutMs: 500,
    });
    const schema = await executeToolCall({
      call: call("echo", { value: "" }, "call-3"),
      registry,
      cwd,
      timeoutMs: 500,
    });

    expect(unknown.type).toBe("observation");
    expect(badJson.type).toBe("observation");
    expect(schema.type).toBe("observation");
    if (
      unknown.type !== "observation" ||
      badJson.type !== "observation" ||
      schema.type !== "observation"
    ) {
      throw new Error("expected observations");
    }

    expect(parse(unknown.output)["error"]).toBe("unknown_tool");
    expect(unknown.callId).toBe("call-1");
    expect(parse(badJson.output)["error"]).toBe("invalid_json");
    expect(badJson.callId).toBe("call-2");
    expect(parse(schema.output)["error"]).toBe("invalid_arguments");
  });

  it("folds a throwing tool and a timeout into observations", async () => {
    const cwd = await tempDir();
    const registry = createRegistry(failingTool, slowTool);

    const thrown = await executeToolCall({
      call: call("boom", {}),
      registry,
      cwd,
      timeoutMs: 500,
    });
    const timedOut = await executeToolCall({
      call: call("slow", {}, "call-2"),
      registry,
      cwd,
      timeoutMs: 20,
    });

    if (thrown.type !== "observation" || timedOut.type !== "observation") {
      throw new Error("expected observations");
    }
    expect(parse(thrown.output)["error"]).toBe("tool_error");
    expect(parse(timedOut.output)["error"]).toBe("timeout");
  });

  it("caps oversized output and marks the truncation explicitly", async () => {
    const cwd = await tempDir();
    const registry = createRegistry(hugeTool);

    const result = await executeToolCall({
      call: call("huge", { size: MAX_OBSERVATION_CHARACTERS * 2 }),
      registry,
      cwd,
      timeoutMs: 1_000,
    });

    if (result.type !== "observation") throw new Error("expected an observation");
    expect(result.ok).toBe(false);
    expect(result.output.length).toBeLessThan(MAX_OBSERVATION_CHARACTERS + 1_000);
    expect(parse(result.output)).toMatchObject({ error: "output_too_large", truncated: true });
  });

  it("preserves the call_id on success and never lets policy see unparsed input", async () => {
    const cwd = await tempDir();
    const registry = createRegistry(echoTool);

    const result = await executeToolCall({
      call: call("echo", { value: "hi" }, "call-42"),
      registry,
      cwd,
      timeoutMs: 500,
    });

    if (result.type !== "observation") throw new Error("expected an observation");
    expect(result.callId).toBe("call-42");
    expect(result.ok).toBe(true);
    expect(parse(result.output)["data"]).toEqual({ echoed: "hi" });
  });
});

describe("workspace boundaries", () => {
  it("rejects reads outside the workspace root", async () => {
    const cwd = await tempDir();
    const outside = await tempDir();
    await writeFile(join(outside, "secret.txt"), "secret", "utf8");
    const registry = createRegistry(readFileTool);

    const result = await executeToolCall({
      call: call("read_file", { path: "../secret.txt" }),
      registry,
      cwd,
      timeoutMs: 500,
    });

    if (result.type !== "observation") throw new Error("expected an observation");
    expect(parse(result.output)["error"]).toBe("path_outside_workspace");
  });

  it("rejects symlinks that point outside the workspace", async () => {
    const cwd = await tempDir();
    const outside = await tempDir();
    await writeFile(join(outside, "secret.txt"), "secret", "utf8");
    await symlink(join(outside, "secret.txt"), join(cwd, "link.txt"));
    const registry = createRegistry(readFileTool);

    const result = await executeToolCall({
      call: call("read_file", { path: "link.txt" }),
      registry,
      cwd,
      timeoutMs: 500,
    });

    if (result.type !== "observation") throw new Error("expected an observation");
    expect(parse(result.output)["error"]).toBe("path_outside_workspace");
  });

  it("reads files inside the workspace with an explicit truncation flag", async () => {
    const cwd = await tempDir();
    await writeFile(join(cwd, "visible.txt"), "needle here\n", "utf8");
    const registry = createRegistry(readFileTool);

    const read = await executeToolCall({
      call: call("read_file", { path: "visible.txt" }),
      registry,
      cwd,
      timeoutMs: 2_000,
    });

    if (read.type !== "observation") throw new Error("expected an observation");
    expect(data(read.output)).toMatchObject({ path: "visible.txt", truncated: false });
    expect(typeof data(read.output)["sha256"]).toBe("string");
  });

  // ripgrep 是外部二进制：CI 会显式安装它，开发者机器上则可能没有。
  it.skipIf(!hasRipgrep)("searches literal text without leaking excluded directories", async () => {
    const cwd = await tempDir();
    await mkdir(join(cwd, "node_modules"), { recursive: true });
    await writeFile(join(cwd, "node_modules", "hidden.txt"), "needle\n", "utf8");
    await writeFile(join(cwd, "visible.txt"), "needle here\n", "utf8");
    const registry = createRegistry(searchTextTool);

    const search = await executeToolCall({
      call: call("search_text", { query: "needle" }, "call-2"),
      registry,
      cwd,
      timeoutMs: 5_000,
    });

    if (search.type !== "observation") throw new Error("expected an observation");
    const matches = data(search.output)["matches"];
    expect(Array.isArray(matches)).toBe(true);
    expect(JSON.stringify(matches)).toContain("visible.txt");
    expect(JSON.stringify(matches)).not.toContain("node_modules");
  });

  it("reports a structured observation instead of throwing when the search binary is missing", async () => {
    const cwd = await tempDir();
    await writeFile(join(cwd, "visible.txt"), "needle\n", "utf8");
    const registry = createRegistry(searchTextTool);

    const originalPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const search = await executeToolCall({
        call: call("search_text", { query: "needle" }, "call-3"),
        registry,
        cwd,
        timeoutMs: 5_000,
      });

      if (search.type !== "observation") throw new Error("expected an observation");
      expect(search.ok).toBe(false);
      expect(search.errorCode).toBe("tool_error");
      expect(JSON.parse(search.output)).toMatchObject({ ok: false, error: "tool_error" });
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });
});

describe("patch preconditions", () => {
  it("creates, updates and deletes a file under SHA-256 preconditions", async () => {
    const cwd = await tempDir();
    const registry = createRegistry(applyPatchTool);

    const created = await executeToolCall({
      call: call("apply_patch", { operation: "create", path: "README.md", content: "# Old\n" }),
      registry,
      cwd,
      timeoutMs: 2_000,
    });
    if (created.type !== "observation") throw new Error("expected an observation");
    expect(created.ok).toBe(true);
    const firstHash = String(data(created.output)["sha256"]);
    expect(await readFile(join(cwd, "README.md"), "utf8")).toBe("# Old\n");

    const updated = await executeToolCall({
      call: call(
        "apply_patch",
        {
          operation: "update",
          path: "README.md",
          expectedSha256: firstHash,
          edits: [{ search: "# Old", replace: "# Hello Agent" }],
        },
        "call-2",
      ),
      registry,
      cwd,
      timeoutMs: 2_000,
    });
    if (updated.type !== "observation") throw new Error("expected an observation");
    expect(updated.ok).toBe(true);
    expect(await readFile(join(cwd, "README.md"), "utf8")).toBe("# Hello Agent\n");

    const secondHash = String(data(updated.output)["sha256"]);
    const deleted = await executeToolCall({
      call: call(
        "apply_patch",
        { operation: "delete", path: "README.md", expectedSha256: secondHash },
        "call-3",
      ),
      registry,
      cwd,
      timeoutMs: 2_000,
    });
    if (deleted.type !== "observation") throw new Error("expected an observation");
    expect(deleted.ok).toBe(true);
    await expect(readFile(join(cwd, "README.md"), "utf8")).rejects.toThrow();
  });

  it("refuses to overwrite a file whose hash changed", async () => {
    const cwd = await tempDir();
    await writeFile(join(cwd, "README.md"), "# Old\n", "utf8");
    const registry = createRegistry(applyPatchTool);
    const read = await executeToolCall({
      call: call("read_file", { path: "README.md" }),
      registry: createRegistry(readFileTool),
      cwd,
      timeoutMs: 1_000,
    });
    if (read.type !== "observation") throw new Error("expected an observation");
    const staleHash = String(data(read.output)["sha256"]);

    await writeFile(join(cwd, "README.md"), "# Manually edited\n", "utf8");

    const patched = await executeToolCall({
      call: call(
        "apply_patch",
        {
          operation: "update",
          path: "README.md",
          expectedSha256: staleHash,
          edits: [{ search: "# Old", replace: "# New" }],
        },
        "call-2",
      ),
      registry,
      cwd,
      timeoutMs: 1_000,
    });

    if (patched.type !== "observation") throw new Error("expected an observation");
    expect(patched.ok).toBe(false);
    expect(parse(patched.output)["error"]).toBe("file_changed");
    expect(await readFile(join(cwd, "README.md"), "utf8")).toBe("# Manually edited\n");
  });

  it("refuses ambiguous edits and file creation outside the workspace", async () => {
    const cwd = await tempDir();
    await writeFile(join(cwd, "dup.txt"), "same\nsame\n", "utf8");
    const registry = createRegistry(applyPatchTool, readFileTool);
    const read = await executeToolCall({
      call: call("read_file", { path: "dup.txt" }),
      registry,
      cwd,
      timeoutMs: 1_000,
    });
    if (read.type !== "observation") throw new Error("expected an observation");
    const hash = String(data(read.output)["sha256"]);

    const ambiguous = await executeToolCall({
      call: call(
        "apply_patch",
        {
          operation: "update",
          path: "dup.txt",
          expectedSha256: hash,
          edits: [{ search: "same", replace: "other" }],
        },
        "call-2",
      ),
      registry,
      cwd,
      timeoutMs: 1_000,
    });
    const escaped = await executeToolCall({
      call: call(
        "apply_patch",
        { operation: "create", path: "../outside.txt", content: "x" },
        "call-3",
      ),
      registry,
      cwd,
      timeoutMs: 1_000,
    });

    if (ambiguous.type !== "observation" || escaped.type !== "observation") {
      throw new Error("expected observations");
    }
    expect(parse(ambiguous.output)["error"]).toBe("edit_not_unique");
    expect(parse(escaped.output)["error"]).toBe("path_outside_workspace");
  });
});

describe("permission policy at the executor boundary", () => {
  it("denies argv that was not generated by the harness", async () => {
    const cwd = await tempDir();
    const registry = createRegistry(runCommandTool);
    const policy: PolicyContext = {
      cwd,
      realWorkspaceRoot: cwd,
      allowedArgv: [["node", "-e", "process.exit(0)"]],
      network: "disabled",
    };

    const result = await executeToolCall({
      call: call("run_command", { command: "node", args: ["-e", "process.exit(1)"] }),
      registry,
      cwd,
      timeoutMs: 2_000,
      policy,
    });

    if (result.type !== "observation") throw new Error("expected an observation");
    expect(parse(result.output)["error"]).toBe("argv_not_allowed");
  });

  it("asks for approval before starting the process and runs only once approved", async () => {
    const cwd = await tempDir();
    const registry = createRegistry(runCommandTool);
    const policy: PolicyContext = {
      cwd,
      realWorkspaceRoot: cwd,
      allowedArgv: [["node", "-e", "console.log('approved')"]],
      network: "disabled",
    };
    const approvals = new InMemoryApprovalLedger();

    const first = await executeToolCall({
      call: call("run_command", { command: "node", args: ["-e", "console.log('approved')"] }),
      registry,
      cwd,
      timeoutMs: 5_000,
      policy,
      approvals,
      runId: "run-1",
    });

    expect(first.type).toBe("waiting");
    if (first.type !== "waiting") throw new Error("expected waiting");
    expect(first.reason).toBe("approval_required");

    const pending = await approvals.pendingRequests("run-1");
    expect(pending).toHaveLength(1);
    const request = pending[0];
    if (!request) throw new Error("approval request missing");

    // 请求未批准前不会有任何输出文件，说明进程没有启动。
    await expect(readFile(join(cwd, "approved.txt"), "utf8")).rejects.toThrow();

    await approvals.approve("run-1", request.id);

    const second = await executeToolCall({
      call: call(
        "run_command",
        { command: "node", args: ["-e", "console.log('approved')"] },
        "call-2",
      ),
      registry,
      cwd,
      timeoutMs: 5_000,
      policy,
      approvals,
      runId: "run-1",
    });

    if (second.type !== "observation") throw new Error("expected an observation");
    expect(second.ok).toBe(true);
    expect(data(second.output)["exitCode"]).toBe(0);
    expect(String(data(second.output)["stdout"])).toContain("approved");

    // 凭证一次性使用。
    const third = await executeToolCall({
      call: call(
        "run_command",
        { command: "node", args: ["-e", "console.log('approved')"] },
        "call-3",
      ),
      registry,
      cwd,
      timeoutMs: 5_000,
      policy,
      approvals,
      runId: "run-1",
    });
    expect(third.type).toBe("waiting");
  });

  it("denies tools with external effects", async () => {
    const cwd = await tempDir();
    const registry = createRegistry(externalTool);

    const result = await executeToolCall({
      call: call("publish_report", { target: "https://example.com" }),
      registry,
      cwd,
      timeoutMs: 1_000,
    });

    if (result.type !== "observation") throw new Error("expected an observation");
    expect(parse(result.output)["error"]).toBe("network_or_external_effect_not_allowed");
  });
});

describe("sandbox gate at the executor boundary", () => {
  const MARKER = "require('node:fs').writeFileSync('started.txt','yes')";
  const ORIGINAL = ["-e", "require('node:fs').writeFileSync('started.txt','original')"];
  const WRAPPED = ["-e", "require('node:fs').writeFileSync('started.txt','wrapped')"];

  /** 用自动批准账本跳过审批门禁，确保被断言的是沙箱门禁本身。 */
  async function runCommandWith(options: {
    cwd: string;
    args: string[];
    sandbox?: Sandbox | undefined;
    requireSandbox?: boolean | undefined;
  }): Promise<ToolExecutionResult> {
    const approvals = new PreApprovingLedger();
    approvals.allowPolicyApprovedCommands();
    const policy: PolicyContext = {
      cwd: options.cwd,
      realWorkspaceRoot: options.cwd,
      allowedArgv: [["node", ...options.args]],
      network: "disabled",
    };

    return executeToolCall({
      call: call("run_command", { command: "node", args: options.args }),
      registry: createRegistry(runCommandTool),
      cwd: options.cwd,
      timeoutMs: 5_000,
      policy,
      approvals,
      runId: "run-sandbox",
      sandbox: options.sandbox,
      requireSandbox: options.requireSandbox,
    });
  }

  it("returns sandbox_unavailable instead of spawning when a required sandbox is unavailable", async () => {
    const cwd = await tempDir();
    let wrapCalls = 0;
    const sandbox: Sandbox = {
      id: "unavailable",
      guarantees: ["network-isolation", "filesystem-write-confinement"],
      isAvailable: async () => false,
      wrap: async () => {
        wrapCalls += 1;
        return { command: "never", args: [] };
      },
    };

    const result = await runCommandWith({
      cwd,
      args: ["-e", MARKER],
      sandbox,
      requireSandbox: true,
    });

    if (result.type !== "observation") throw new Error("expected an observation");
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("sandbox_unavailable");
    expect(parse(result.output)["error"]).toBe("sandbox_unavailable");
    // 门禁在 spawn 之前拒绝：包装器没被调用，进程也没有留下任何副作用。
    expect(wrapCalls).toBe(0);
    await expect(readFile(join(cwd, "started.txt"), "utf8")).rejects.toThrow();
  });

  it("refuses an injected sandbox that is unavailable even when isolation is not required", async () => {
    const cwd = await tempDir();
    const sandbox: Sandbox = {
      id: "unavailable",
      guarantees: ["network-isolation", "filesystem-write-confinement"],
      isAvailable: async () => false,
      wrap: async () => ({ command: "never", args: [] }),
    };

    const result = await runCommandWith({
      cwd,
      args: ["-e", MARKER],
      sandbox,
      requireSandbox: false,
    });

    if (result.type !== "observation") throw new Error("expected an observation");
    expect(result.errorCode).toBe("sandbox_unavailable");
    await expect(readFile(join(cwd, "started.txt"), "utf8")).rejects.toThrow();
  });

  it("refuses when the sandbox cannot guarantee the network isolation the policy declares", async () => {
    const cwd = await tempDir();
    let wrapCalls = 0;
    const sandbox: Sandbox = {
      id: "filesystem-only",
      guarantees: ["filesystem-write-confinement"],
      isAvailable: async () => true,
      wrap: async () => {
        wrapCalls += 1;
        return { command: "never", args: [] };
      },
    };

    const result = await runCommandWith({
      cwd,
      args: ["-e", MARKER],
      sandbox,
      requireSandbox: true,
    });

    if (result.type !== "observation") throw new Error("expected an observation");
    expect(result.errorCode).toBe("sandbox_network_isolation_unsupported");
    expect(wrapCalls).toBe(0);
    await expect(readFile(join(cwd, "started.txt"), "utf8")).rejects.toThrow();
  });

  it("keeps today's behavior when noSandbox is injected without requireSandbox", async () => {
    const cwd = await tempDir();

    const result = await runCommandWith({
      cwd,
      args: ["-e", MARKER],
      sandbox: noSandbox,
      requireSandbox: false,
    });

    if (result.type !== "observation") throw new Error("expected an observation");
    expect(result.ok).toBe(true);
    expect(data(result.output)["exitCode"]).toBe(0);
    expect(await readFile(join(cwd, "started.txt"), "utf8")).toBe("yes");
  });

  it("spawns the argv produced by an available sandbox and forwards the workspace policy", async () => {
    const cwd = await tempDir();
    const seen: { input: SandboxCommand; policy: SandboxPolicy }[] = [];
    const sandbox: Sandbox = {
      id: "recording",
      guarantees: ["network-isolation", "filesystem-write-confinement"],
      isAvailable: async () => true,
      async wrap(input, policy) {
        seen.push({ input, policy });
        return { command: "node", args: [...WRAPPED] };
      },
    };

    const result = await runCommandWith({
      cwd,
      args: [...ORIGINAL],
      sandbox,
      requireSandbox: true,
    });

    if (result.type !== "observation") throw new Error("expected an observation");
    expect(result.ok).toBe(true);
    expect(seen).toEqual([
      {
        input: { command: "node", args: [...ORIGINAL], cwd },
        policy: { network: "disabled", writableRoot: cwd },
      },
    ]);
    // 落盘的是包装后的 argv，而不是原始 argv。
    expect(await readFile(join(cwd, "started.txt"), "utf8")).toBe("wrapped");
  });
});
