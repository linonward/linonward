import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { canonicalJson, isRecord, sha256 } from "./checkpoint.js";
import type { RegisteredTool } from "./tool.js";

/** 拒绝细节里最多保留多少条允许的 argv：超出的部分只保留计数。 */
export const MAX_ALLOWED_ARGV_PREVIEW = 5;
/** 拒绝细节里单条 argv 预览的最大字符数。 */
export const MAX_ALLOWED_ARGV_PREVIEW_CHARACTERS = 120;

/**
 * 策略拒绝时附带的**机器可读**细节。
 *
 * 只放可序列化的原始值，并且每一项都有界：`argv_not_allowed` 只带前
 * `MAX_ALLOWED_ARGV_PREVIEW` 条允许 argv、实际条数与省略条数；
 * `network_*` 只带当前 `network` 值。错误码本身仍是 `PolicyDecision.reason`，
 * 这里既不重复、也不改变它的语义。
 */
export type PolicyDenyDetails =
  | {
      kind: "argv_not_allowed";
      /** 实际配置的允许条数（不受预览上限影响）。 */
      allowedArgvCount: number;
      /** 有界预览：每条 argv 已渲染为一行并截断到 `MAX_ALLOWED_ARGV_PREVIEW_CHARACTERS`。 */
      allowedArgvPreview: string[];
      /** 预览省略掉的条数，便于直接渲染 `…(+N more)`。 */
      allowedArgvOmitted: number;
    }
  | { kind: "network"; network: PolicyContext["network"] };

export type PolicyDecision =
  | { type: "allow"; scope: string }
  | { type: "deny"; reason: string; details?: PolicyDenyDetails }
  | { type: "ask"; request: ApprovalRequest };

export interface ApprovalRequest {
  id: string;
  actionDigest: string;
  summary: string;
  risks: string[];
  expiresAt: string;
}

/** 一次性批准凭证。绑定 digest，消费后立即失效。 */
export interface ApprovalGrant {
  actionDigest: string;
  approvedAt: string;
  expiresAt: string;
}

export interface PolicyContext {
  cwd: string;
  realWorkspaceRoot: string;
  allowedArgv: string[][];
  /**
   * 只是**声明**，不是隔离：`"disabled"` 会让策略层拒绝产生外部副作用的工具，
   * 但不会给已经放行的 `run_command` 子进程禁网。真正禁止网络、把写入限制在工作区内，
   * 必须依赖 `src/sandbox.ts` 的 OS 沙箱或外部容器（见 README"进程隔离"）。
   */
  network: "disabled" | "enabled";
}

export interface ApprovalLedger {
  saveApprovalRequest(runId: string, request: ApprovalRequest): Promise<void>;
  pendingRequests(runId: string): Promise<ApprovalRequest[]>;
  approve(runId: string, requestId: string, now?: Date): Promise<ApprovalGrant>;
  consumeApprovalGrant(
    runId: string,
    actionDigest: string,
    now?: Date,
  ): Promise<ApprovalGrant | undefined>;
  /** 目标或参数变化后，旧批准必须失效。 */
  invalidateRun(runId: string): Promise<void>;
}

export const APPROVAL_TTL_MS = 15 * 60 * 1000;

/**
 * `actionDigest` 绑定工具名、规范化输入、cwd 与网络策略。
 * 参数或环境只要有一项变化，旧批准就无法复用。
 */
export function actionDigestFor(options: {
  tool: Pick<RegisteredTool, "name" | "effect">;
  input: unknown;
  cwd: string;
  network: "disabled" | "enabled";
}): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        tool: options.tool.name,
        effect: options.tool.effect,
        input: options.input,
        cwd: options.cwd,
        network: options.network,
      }),
    )
    .digest("hex");
}

export function createApprovalRequest(options: {
  tool: Pick<RegisteredTool, "name" | "effect">;
  input: unknown;
  cwd: string;
  network: "disabled" | "enabled";
  summary: string;
  risks: string[];
  now?: Date | undefined;
  ttlMs?: number | undefined;
}): ApprovalRequest {
  const now = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? APPROVAL_TTL_MS;

  return {
    id: randomUUID(),
    actionDigest: actionDigestFor(options),
    summary: options.summary,
    risks: options.risks,
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  };
}

function isRunCommandInput(input: unknown): input is { command: string; args: string[] } {
  return (
    isRecord(input) &&
    typeof input.command === "string" &&
    Array.isArray(input.args) &&
    input.args.every((argument) => typeof argument === "string")
  );
}

function isPathInput(input: unknown): input is { path: string } {
  return isRecord(input) && typeof input.path === "string";
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isInside(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target);
  return pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot);
}

/** 把允许列表压成有界预览：条数与单条字符数都设上限，模型/操作者仍能看到全貌与总数。 */
function boundedAllowedArgvPreview(allowedArgv: readonly string[][]): {
  count: number;
  preview: string[];
  omitted: number;
} {
  const preview = allowedArgv.slice(0, MAX_ALLOWED_ARGV_PREVIEW).map((argv) => {
    const rendered = argv.join(" ");
    return rendered.length <= MAX_ALLOWED_ARGV_PREVIEW_CHARACTERS
      ? rendered
      : `${rendered.slice(0, MAX_ALLOWED_ARGV_PREVIEW_CHARACTERS)}…`;
  });

  return {
    count: allowedArgv.length,
    preview,
    omitted: allowedArgv.length - preview.length,
  };
}

function argvNotAllowedDetails(allowedArgv: readonly string[][]): PolicyDenyDetails {
  const bounded = boundedAllowedArgvPreview(allowedArgv);
  return {
    kind: "argv_not_allowed",
    allowedArgvCount: bounded.count,
    allowedArgvPreview: bounded.preview,
    allowedArgvOmitted: bounded.omitted,
  };
}

/** 只做语法级预检；真正的 realpath 边界由 workspace.ts 在工具内部强制执行。 */
function authorizeWorkspacePath(
  tool: RegisteredTool,
  input: unknown,
  realWorkspaceRoot: string,
): PolicyDecision {
  if (!isPathInput(input)) return { type: "allow", scope: `${tool.effect}:${tool.name}` };

  const target = resolve(realWorkspaceRoot, input.path);
  if (!isInside(realWorkspaceRoot, target)) {
    return { type: "deny", reason: "path_outside_workspace" };
  }
  return { type: "allow", scope: `${tool.effect}:${input.path}` };
}

/**
 * 策略输入必须包含已经通过 schema 校验的参数与运行上下文；
 * 只看工具名或 effect 无法判断实际目标。
 */
export function authorize(
  tool: RegisteredTool,
  input: unknown,
  context: PolicyContext,
): PolicyDecision {
  if (tool.effect === "read" || tool.effect === "write") {
    return authorizeWorkspacePath(tool, input, context.realWorkspaceRoot);
  }

  if (tool.name === "run_command") {
    if (!isRunCommandInput(input)) return { type: "deny", reason: "invalid_command_input" };

    const argv = [input.command, ...input.args];
    const exactMatch = context.allowedArgv.some((allowed) => arraysEqual(argv, allowed));
    if (!exactMatch) {
      return {
        type: "deny",
        reason: "argv_not_allowed",
        details: argvNotAllowedDetails(context.allowedArgv),
      };
    }

    return {
      type: "ask",
      request: createApprovalRequest({
        tool,
        input,
        cwd: context.cwd,
        network: context.network,
        summary: `Run ${argv.join(" ")} in ${context.cwd}`,
        risks: [
          "The process runs with the current user's permissions.",
          "Arguments can execute arbitrary code inside the workspace.",
        ],
      }),
    };
  }

  if (tool.effect === "external" || context.network !== "disabled") {
    return {
      type: "deny",
      reason: "network_or_external_effect_not_allowed",
      details: { kind: "network", network: context.network },
    };
  }

  return { type: "deny", reason: "no_matching_policy" };
}

export const POLICY_DENIAL_REASONS = new Set([
  "path_outside_workspace",
  "invalid_command_input",
  "argv_not_allowed",
  "network_or_external_effect_not_allowed",
  "no_matching_policy",
]);

/** 离线、确定的一次性批准账本；持久实现只需满足同一接口。 */
export class InMemoryApprovalLedger implements ApprovalLedger {
  private readonly requests = new Map<string, ApprovalRequest[]>();
  private readonly grants = new Map<string, Map<string, ApprovalGrant>>();

  async saveApprovalRequest(runId: string, request: ApprovalRequest): Promise<void> {
    const existing = this.requests.get(runId) ?? [];
    const withoutDuplicate = existing.filter((candidate) => candidate.id !== request.id);
    this.requests.set(runId, [...withoutDuplicate, request]);
  }

  async pendingRequests(runId: string): Promise<ApprovalRequest[]> {
    return [...(this.requests.get(runId) ?? [])];
  }

  async approve(runId: string, requestId: string, now = new Date()): Promise<ApprovalGrant> {
    const pending = this.requests.get(runId) ?? [];
    const request = pending.find((candidate) => candidate.id === requestId);
    if (!request) throw new Error("unknown_approval_request");
    if (Date.parse(request.expiresAt) <= now.getTime()) throw new Error("approval_request_expired");

    const grant: ApprovalGrant = {
      actionDigest: request.actionDigest,
      approvedAt: now.toISOString(),
      expiresAt: request.expiresAt,
    };
    const forRun = this.grants.get(runId) ?? new Map<string, ApprovalGrant>();
    forRun.set(grant.actionDigest, grant);
    this.grants.set(runId, forRun);
    return grant;
  }

  async consumeApprovalGrant(
    runId: string,
    actionDigest: string,
    now = new Date(),
  ): Promise<ApprovalGrant | undefined> {
    const forRun = this.grants.get(runId);
    const grant = forRun?.get(actionDigest);
    if (!forRun || !grant) return undefined;

    forRun.delete(actionDigest);
    if (Date.parse(grant.expiresAt) <= now.getTime()) return undefined;
    return grant;
  }

  async invalidateRun(runId: string): Promise<void> {
    this.grants.delete(runId);
    this.requests.delete(runId);
  }
}

/** 供审计与测试使用的稳定摘要，不暴露原始输入。 */
export function digestOf(value: unknown): string {
  return sha256(canonicalJson(value));
}
