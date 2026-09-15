import { spawn } from "node:child_process";
import { z } from "zod";

import { type SandboxPolicy, wrapWithSandbox } from "../sandbox.js";
import { defineTool, type ToolContext } from "../tool.js";

export const RUN_COMMAND_TIMEOUT_MS = 60_000;
export const RUN_COMMAND_MAX_OUTPUT_CHARACTERS = 20_000;

export const runCommandInputSchema = z
  .object({
    command: z.enum(["pnpm", "node"]),
    args: z.array(z.string()).max(20),
    purpose: z.string().max(200).optional(),
  })
  .strict();

export type RunCommandInput = z.infer<typeof runCommandInputSchema>;

function capOutput(value: string): { text: string; truncated: boolean } {
  if (value.length <= RUN_COMMAND_MAX_OUTPUT_CHARACTERS) {
    return { text: value, truncated: false };
  }
  return { text: value.slice(0, RUN_COMMAND_MAX_OUTPUT_CHARACTERS), truncated: true };
}

/**
 * 沙箱接线：字段与 `ToolContext` 上同名，executor 透传。
 * 未注入时 `sandbox` 为 `undefined`，`wrapWithSandbox` 原样返回 argv。
 */
export interface RunCommandOptions {
  sandbox?: ToolContext["sandbox"];
  requireSandbox?: ToolContext["requireSandbox"];
  sandboxPolicy?: ToolContext["sandboxPolicy"];
}

function policyFor(options: RunCommandOptions & { cwd: string }): SandboxPolicy {
  return options.sandboxPolicy ?? { network: "disabled", writableRoot: options.cwd };
}

/**
 * 参数必须拆成 `command` 与 `args`，并且永远 `shell: false`。
 * 这不代表 `pnpm` 或 `node` 本身安全，它们仍能执行任意代码；
 * 真正的边界由权限策略、人工批准与外部进程隔离提供。
 *
 * 进程隔离是**可选注入**的（`ToolContext.sandbox`）。一旦注入了一个真沙箱，
 * 或者调用方打开 `requireSandbox`，这里就只会"要么真隔离、要么抛错"：
 * 不可用或无法满足 `network: "disabled"` 时抛 `sandbox_unavailable` /
 * `sandbox_network_isolation_unsupported`，绝不退回无隔离执行。
 */
export const runCommandTool = defineTool({
  name: "run_command",
  description:
    "Run one allowed executable (pnpm or node) with an explicit argv array. No shell string is accepted.",
  effect: "execute",
  schema: runCommandInputSchema,
  async execute(input, context) {
    const sandboxPolicy = policyFor(context);
    const wrapped = await wrapWithSandbox(
      { command: input.command, args: input.args, cwd: context.cwd },
      {
        sandbox: context.sandbox,
        requireSandbox: context.requireSandbox,
        policy: sandboxPolicy,
      },
    );

    const startedAt = Date.now();
    const timeout = AbortSignal.timeout(RUN_COMMAND_TIMEOUT_MS);
    const signal = AbortSignal.any([context.signal, timeout]);
    const child = spawn(wrapped.command, wrapped.args, {
      cwd: context.cwd,
      shell: false,
      signal,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const exitCode = await new Promise<number>((resolveExit, rejectExit) => {
      child.once("error", (error) => rejectExit(error));
      child.once("close", (code, closeSignal) => {
        if (code !== null) return resolveExit(code);
        resolveExit(closeSignal ? 128 : -1);
      });
    });

    const captured = capOutput(stdout);
    const capturedError = capOutput(stderr);

    return {
      command: input.command,
      args: input.args,
      exitCode,
      stdout: captured.text,
      stderr: capturedError.text,
      truncated: captured.truncated || capturedError.truncated,
      durationMs: Date.now() - startedAt,
    };
  },
});
