import { isRecord } from "./checkpoint.js";
import {
  type EvaluationCase,
  type EvaluationReport,
  type EvaluationResult,
  isAgentStatus,
  runEvaluation,
} from "./eval.js";
import { addUsage, emptyUsage, type RunUsage } from "./trace.js";
import type { AgentState } from "./types.js";

export const CAPSTONE_SUITE_VERSION = "1.0.0";

/** Capstone case 在基础评测契约上声明预算、允许副作用与文件断言。 */
export interface CapstoneCase extends EvaluationCase {
  maxSteps: number;
  maxToolCalls: number;
  allowSideEffects: boolean;
  expectedFiles: string[];
}

export interface CapstoneDependencies {
  createFixture(caseId: string): Promise<{ cwd: string; dispose(): Promise<void> }>;
  runCase(testCase: EvaluationCase, cwd: string): Promise<EvaluationResult>;
}

export interface CapstoneSummary {
  suiteVersion: string;
  passedCases: string[];
  failedCases: string[];
  correctlyBlockedCases: string[];
  taskSuccessRate: number;
  totalUsage: RunUsage;
  traceIds: string[];
}

/**
 * suite runner 强制为每个 case 建立独立 fixture，并复用同一评测入口。
 * 重复 case ID 直接拒绝，避免两个 case 共享工作区或 approval grant。
 */
export async function runCapstoneSuite(
  cases: EvaluationCase[],
  dependencies: CapstoneDependencies,
): Promise<EvaluationReport> {
  const seen = new Set<string>();
  for (const testCase of cases) {
    if (seen.has(testCase.id)) throw new Error(`duplicate capstone case: ${testCase.id}`);
    seen.add(testCase.id);
  }

  return runEvaluation(cases, async (testCase) => {
    const fixture = await dependencies.createFixture(testCase.id);
    try {
      return await dependencies.runCase(testCase, fixture.cwd);
    } finally {
      await fixture.dispose();
    }
  });
}

/** 任何失败或证据不足都会让 suite 失败，而不是被平均成功率掩盖。 */
export function assertCapstonePassed(report: EvaluationReport): void {
  const failures = report.results.filter(
    (result) => result.outcome === "failed" || result.outcome === "inconclusive",
  );
  if (failures.length > 0) {
    throw new Error(`capstone failed: ${failures.map((result) => result.caseId).join(", ")}`);
  }
}

export function summarizeCapstone(report: EvaluationReport): CapstoneSummary {
  const totalUsage = report.results.reduce(
    (total, result) => addUsage(total, result.usage),
    emptyUsage(),
  );
  const total = report.results.length;

  return {
    suiteVersion: CAPSTONE_SUITE_VERSION,
    passedCases: report.results
      .filter((result) => result.outcome === "passed")
      .map((result) => result.caseId),
    failedCases: report.results
      .filter((result) => result.outcome === "failed")
      .map((result) => result.caseId),
    correctlyBlockedCases: report.results
      .filter((result) => result.outcome === "correctly_blocked")
      .map((result) => result.caseId),
    taskSuccessRate: total === 0 ? 0 : report.passed / total,
    totalUsage,
    traceIds: report.results.map((result) => result.traceId),
  };
}

/** 从 `evals/capstone.jsonl` 解析固定 fixture。 */
export function parseCapstoneCases(text: string): CapstoneCase[] {
  const cases: CapstoneCase[] = [];

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed: unknown = JSON.parse(trimmed);
    if (
      !isRecord(parsed) ||
      typeof parsed["id"] !== "string" ||
      typeof parsed["task"] !== "string" ||
      !isAgentStatus(parsed["expectedStatus"])
    ) {
      throw new Error("invalid capstone case");
    }

    cases.push({
      id: parsed["id"],
      task: parsed["task"],
      expectedStatus: parsed["expectedStatus"],
      maxSteps: typeof parsed["maxSteps"] === "number" ? parsed["maxSteps"] : 12,
      maxToolCalls: typeof parsed["maxToolCalls"] === "number" ? parsed["maxToolCalls"] : 24,
      allowSideEffects: parsed["allowSideEffects"] === true,
      expectedFiles: Array.isArray(parsed["expectedFiles"])
        ? parsed["expectedFiles"].filter((value): value is string => typeof value === "string")
        : [],
    });
  }

  return cases;
}

/** 任务矩阵里的安全断言：任何越权写入都直接判失败。 */
export function assertNoForbiddenSideEffects(input: {
  expectedStatus: AgentState["status"];
  actualStatus: AgentState["status"];
  changedFiles: string[];
  allowedFiles: string[];
}): void {
  const forbidden = input.changedFiles.filter((file) => !input.allowedFiles.includes(file));
  if (forbidden.length > 0) {
    throw new Error(`forbidden side effects: ${forbidden.join(", ")}`);
  }
}
