import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { ZodError } from "zod";

import type { ToolCall } from "./model.js";
import {
  InMemoryApprovalLedger,
  authorize,
  type ApprovalLedger,
  type PolicyContext,
} from "./policy.js";
import { InMemoryWriteLease, type ToolEffect, type WriteLease } from "./tool.js";
import type { ToolRegistry } from "./tool-registry.js";
import type { AgentEventInput, SkillState } from "./types.js";

export const MAX_OBSERVATION_CHARACTERS = 12_000;

/** 已知的、可以安全回传给模型的错误码；其余错误统一折叠为 `tool_error`。 */
export const KNOWN_TOOL_ERRORS: ReadonlySet<string> = new Set([
  "path_outside_workspace",
  "path_not_found",
  "file_changed",
  "edit_not_found",
  "edit_not_unique",
  "skill_too_large",
  "unknown_skill",
  "skill_not_active",
  "resource_type_not_loadable",
  "binary_resource_denied",
  "skill_resource_too_large",
]);

export const DENIED_TOOL_ERRORS: ReadonlySet<string> = new Set([
  "path_outside_workspace",
  "invalid_command_input",
  "argv_not_allowed",
  "network_or_external_effect_not_allowed",
  "no_matching_policy",
]);

export interface ToolObservation {
  type: "observation";
  callId: string;
  output: string;
  ok: boolean;
  effect: ToolEffect | "unknown";
  errorCode?: string | undefined;
}

export type ToolExecutionResult =
  | ToolObservation
  | { type: "waiting"; requestId: string; reason: "approval_required" };

export interface ExecuteToolCallOptions {
  call: ToolCall;
  registry: ToolRegistry;
  cwd: string;
  timeoutMs: number;
  policy?: PolicyContext | undefined;
  approvals?: ApprovalLedger | undefined;
  runId?: string | undefined;
  writeLease?: WriteLease | undefined;
  skills?: SkillState | undefined;
  maxSkillBytes?: number | undefined;
  signal?: AbortSignal | undefined;
  now?: Date | undefined;
  emit?: ((event: AgentEventInput) => void) | undefined;
}

function emptySkills(): SkillState {
  return { catalog: [], activeSkills: {} };
}

async function defaultPolicyContext(cwd: string): Promise<PolicyContext> {
  let root: string;
  try {
    root = await realpath(resolve(cwd));
  } catch {
    root = resolve(cwd);
  }
  return { cwd: root, realWorkspaceRoot: root, allowedArgv: [], network: "disabled" };
}

/** 只要序列化结果超限，就替换为带 preview 的显式截断标记。 */
function observationFromValue(
  callId: string,
  value: unknown,
  metadata: { ok: boolean; effect: ToolEffect | "unknown"; errorCode?: string | undefined },
): ToolObservation {
  const serialized = JSON.stringify(value ?? null);

  if (serialized.length > MAX_OBSERVATION_CHARACTERS) {
    return {
      type: "observation",
      callId,
      ok: false,
      effect: metadata.effect,
      errorCode: "output_too_large",
      output: JSON.stringify({
        ok: false,
        error: "output_too_large",
        truncated: true,
        preview: serialized.slice(0, MAX_OBSERVATION_CHARACTERS),
      }),
    };
  }

  const observation: ToolObservation = {
    type: "observation",
    callId,
    output: serialized,
    ok: metadata.ok,
    effect: metadata.effect,
  };
  if (metadata.errorCode !== undefined) observation.errorCode = metadata.errorCode;
  return observation;
}

function failure(callId: string, code: string, message: string, effect: ToolEffect | "unknown") {
  return observationFromValue(
    callId,
    { ok: false, error: code, message: message.slice(0, 500) },
    { ok: false, effect, errorCode: code },
  );
}

/**
 * 未知工具、坏 JSON、Schema 失败、超时和工具异常都返回结构化 observation，
 * 而不是让循环崩溃。顺序固定为：Schema 校验 → `prepare` → `authorize` → 执行。
 */
export async function executeToolCall(
  options: ExecuteToolCallOptions,
): Promise<ToolExecutionResult> {
  const tool = options.registry.get(options.call.name);
  if (!tool) {
    return failure(
      options.call.callId,
      "unknown_tool",
      `unknown tool: ${options.call.name}`,
      "unknown",
    );
  }

  let rawInput: unknown;
  try {
    rawInput = JSON.parse(options.call.argumentsJson);
  } catch {
    return failure(
      options.call.callId,
      "invalid_json",
      "arguments are not valid JSON",
      tool.effect,
    );
  }

  let prepared: ReturnType<typeof tool.prepare>;
  try {
    prepared = tool.prepare(rawInput);
  } catch (error) {
    if (error instanceof ZodError) {
      return failure(
        options.call.callId,
        "invalid_arguments",
        error.issues.map((issue) => issue.path.join(".") + ": " + issue.message).join("; "),
        tool.effect,
      );
    }
    throw error;
  }

  const policy = options.policy ?? (await defaultPolicyContext(options.cwd));
  const decision = authorize(tool, prepared.input, policy);

  if (decision.type === "deny") {
    return failure(options.call.callId, decision.reason, decision.reason, tool.effect);
  }

  if (decision.type === "ask") {
    const approvals = options.approvals ?? new InMemoryApprovalLedger();
    const runId = options.runId ?? "anonymous-run";

    // 先落盘请求、再判定是否已有凭证：审计不会因为"已经批准过"而丢掉这次请求，
    // 账本也可以在保存时发放凭证（例如"策略已放行即批准"的无人值守实现）。
    await approvals.saveApprovalRequest(runId, decision.request);
    const grant = await approvals.consumeApprovalGrant(
      runId,
      decision.request.actionDigest,
      options.now,
    );
    if (!grant) {
      return {
        type: "waiting",
        requestId: decision.request.id,
        reason: "approval_required",
      };
    }
  }

  const controller = new AbortController();
  const onOuterAbort = (): void => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", onOuterAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const timedOut = (): boolean => controller.signal.aborted;

  try {
    const data = await prepared.execute({
      cwd: options.cwd,
      signal: controller.signal,
      writeLease: options.writeLease ?? new InMemoryWriteLease(),
      skills: options.skills ?? emptySkills(),
      maxSkillBytes: options.maxSkillBytes ?? 64_000,
      emit: options.emit ?? ((): void => undefined),
    });
    return observationFromValue(
      options.call.callId,
      { ok: true, data },
      { ok: true, effect: tool.effect },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code =
      timedOut() && !options.signal?.aborted
        ? "timeout"
        : error instanceof ZodError
          ? "invalid_arguments"
          : KNOWN_TOOL_ERRORS.has(message)
            ? message
            : "tool_error";
    return failure(options.call.callId, code, message, tool.effect);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onOuterAbort);
  }
}
