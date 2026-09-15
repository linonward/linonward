import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";

import { canonicalJson, isRecord, sha256 } from "./checkpoint.js";
import type { RegisteredTool } from "./tool.js";

export type PolicyDecision =
  | { type: "allow"; scope: string }
  | { type: "deny"; reason: string }
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
    if (!exactMatch) return { type: "deny", reason: "argv_not_allowed" };

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
    return { type: "deny", reason: "network_or_external_effect_not_allowed" };
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
