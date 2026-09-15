import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { ZodError } from "zod";

import type { ToolCall } from "./model.js";
import {
  type ApprovalLedger,
  authorize,
  InMemoryApprovalLedger,
  MAX_ALLOWED_ARGV_PREVIEW,
  MAX_ALLOWED_ARGV_PREVIEW_CHARACTERS,
  type PolicyContext,
  type PolicyDenyDetails,
} from "./policy.js";
import { type Sandbox, SandboxError } from "./sandbox.js";
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
  "sandbox_unavailable",
  "sandbox_network_isolation_unsupported",
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
  /** 可选注入的进程沙箱；透传给工具（目前只有 `run_command` 使用）。 */
  sandbox?: Sandbox | undefined;
  /** 调用方显式要求隔离；`true` 时"没有真隔离"一律拒绝执行。 */
  requireSandbox?: boolean | undefined;
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

/** 普通工具错误沿用既有 500 字符上限；策略拒绝用更长的独立上限（见下）。 */
const MAX_FAILURE_MESSAGE_CHARACTERS = 500;

/**
 * 策略拒绝的 message 上限。预览已被 policy 限成
 * `MAX_ALLOWED_ARGV_PREVIEW` 条 × `MAX_ALLOWED_ARGV_PREVIEW_CHARACTERS` 字符，
 * 因此这里只需要一个确定的上限，确保 `…(+N more)` 不会被截掉。
 */
export const MAX_DENIAL_MESSAGE_CHARACTERS = 1_024;

function failureWithLimit(
  callId: string,
  code: string,
  message: string,
  effect: ToolEffect | "unknown",
  maxMessageCharacters: number,
) {
  return observationFromValue(
    callId,
    { ok: false, error: code, message: message.slice(0, maxMessageCharacters) },
    { ok: false, effect, errorCode: code },
  );
}

function failure(callId: string, code: string, message: string, effect: ToolEffect | "unknown") {
  return failureWithLimit(callId, code, message, effect, MAX_FAILURE_MESSAGE_CHARACTERS);
}

function truncateDeniedArgv(rendered: string): string {
  return rendered.length <= MAX_ALLOWED_ARGV_PREVIEW_CHARACTERS
    ? rendered
    : `${rendered.slice(0, MAX_ALLOWED_ARGV_PREVIEW_CHARACTERS)}…`;
}

/** 白名单为空时的固定指引：让模型/操作者知道问题在配置，而不是这次请求的写法。 */
const EMPTY_ALLOWED_ARGV_HINT =
  "当前没有配置任何允许的 argv；需要执行命令时请用 `--allow <command> [args...]` 预先放行";

/**
 * 策略拒绝的 message：`error` 仍然是原来的错误码，这里只补**有界**、可操作的细节。
 *
 * 白名单为空时给出明确指引——"不是这次请求写错了，而是根本没有放行任何命令"；
 * 非空时给出允许条数与预览，让模型知道下一步该改成什么，或者直接如实回答。
 */
function denialMessage(decision: { reason: string; details?: PolicyDenyDetails }): string {
  const details = decision.details;

  if (details?.kind === "argv_not_allowed") {
    if (details.allowedArgvCount === 0) {
      return `argv_not_allowed: ${EMPTY_ALLOWED_ARGV_HINT}`;
    }

    const preview = details.allowedArgvPreview
      .slice(0, MAX_ALLOWED_ARGV_PREVIEW)
      .map(truncateDeniedArgv);
    if (details.allowedArgvOmitted > 0) preview.push(`…(+${details.allowedArgvOmitted} more)`);

    return [
      `argv_not_allowed: 允许的 argv 共 ${details.allowedArgvCount} 条，这次请求不在其中。`,
      `允许的 argv 预览：${preview.join("; ")}`,
    ].join(" ");
  }

  if (details?.kind === "network") {
    return [
      `network_or_external_effect_not_allowed: 当前 network=${details.network}，`,
      "该工具可能产生网络或外部副作用，已被策略拒绝。",
    ].join("");
  }

  return decision.reason;
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
    return failureWithLimit(
      options.call.callId,
      decision.reason,
      denialMessage(decision),
      tool.effect,
      MAX_DENIAL_MESSAGE_CHARACTERS,
    );
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
      sandbox: options.sandbox,
      requireSandbox: options.requireSandbox,
      sandboxPolicy: { network: policy.network, writableRoot: policy.realWorkspaceRoot },
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
          : error instanceof SandboxError
            ? error.code
            : KNOWN_TOOL_ERRORS.has(message)
              ? message
              : "tool_error";
    return failure(options.call.callId, code, message, tool.effect);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onOuterAbort);
  }
}
