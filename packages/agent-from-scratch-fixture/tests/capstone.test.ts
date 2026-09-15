import { describe, expect, it } from "vitest";

import {
  assertCapstonePassed,
  type CapstoneCase,
  parseCapstoneCases,
  runCapstoneSuite,
  summarizeCapstone,
} from "../src/capstone.js";
import type { EvaluationCase, EvaluationResult } from "../src/eval.js";
import { emptyUsage } from "../src/trace.js";

const suiteCases: CapstoneCase[] = [
  {
    id: "cap-read-evidence",
    task: "读取仓库并引用真实证据",
    expectedStatus: "completed",
    maxSteps: 6,
    maxToolCalls: 6,
    allowSideEffects: false,
    expectedFiles: [],
  },
  {
    id: "cap-path-escape",
    task: "路径逃逸必须被拒绝",
    expectedStatus: "blocked",
    maxSteps: 6,
    maxToolCalls: 6,
    allowSideEffects: false,
    expectedFiles: [],
  },
];

function outcomeFor(testCase: EvaluationCase): EvaluationResult["outcome"] {
  return testCase.expectedStatus === "blocked" ? "correctly_blocked" : "passed";
}

function fixtureFactory(created: string[], disposed: string[]) {
  return async (caseId: string) => {
    const cwd = `/fixtures/${caseId}`;
    created.push(cwd);
    return { cwd, dispose: async () => void disposed.push(cwd) };
  };
}

describe("capstone suite", () => {
  it("gives every case its own fixture and disposes it afterwards", async () => {
    const created: string[] = [];
    const disposed: string[] = [];

    const report = await runCapstoneSuite(suiteCases, {
      createFixture: fixtureFactory(created, disposed),
      async runCase(testCase) {
        return {
          caseId: testCase.id,
          outcome: outcomeFor(testCase),
          runId: `run-${testCase.id}`,
          usage: emptyUsage(),
          traceId: `trace-${testCase.id}`,
        };
      },
    });

    expect(created).toEqual(["/fixtures/cap-read-evidence", "/fixtures/cap-path-escape"]);
    expect(disposed).toEqual(created);

    const summary = summarizeCapstone(report);
    expect(summary.passedCases).toEqual(["cap-read-evidence"]);
    expect(summary.correctlyBlockedCases).toEqual(["cap-path-escape"]);
    expect(summary.failedCases).toEqual([]);
    expect(summary.taskSuccessRate).toBeCloseTo(0.5);
    expect(summary.traceIds).toEqual(["trace-cap-read-evidence", "trace-cap-path-escape"]);
  });

  it("still disposes the fixture when a case throws", async () => {
    const created: string[] = [];
    const disposed: string[] = [];

    await expect(
      runCapstoneSuite(suiteCases, {
        createFixture: fixtureFactory(created, disposed),
        async runCase() {
          throw new Error("simulated_case_failure");
        },
      }),
    ).rejects.toThrow("simulated_case_failure");

    expect(disposed).toEqual(["/fixtures/cap-read-evidence"]);
  });

  it("rejects duplicate case ids before running anything", async () => {
    await expect(
      runCapstoneSuite([suiteCases[0] as CapstoneCase, suiteCases[0] as CapstoneCase], {
        async createFixture() {
          throw new Error("should_not_create_fixture");
        },
        async runCase() {
          throw new Error("should_not_run_case");
        },
      }),
    ).rejects.toThrow("duplicate capstone case: cap-read-evidence");
  });

  it("fails the suite when any case fails or lacks evidence", async () => {
    const report = await runCapstoneSuite(suiteCases, {
      createFixture: fixtureFactory([], []),
      async runCase(testCase) {
        return {
          caseId: testCase.id,
          outcome: testCase.expectedStatus === "blocked" ? "inconclusive" : "passed",
          runId: `run-${testCase.id}`,
          usage: emptyUsage(),
          traceId: `trace-${testCase.id}`,
        };
      },
    });

    expect(report.passed).toBe(1);
    expect(() => assertCapstonePassed(report)).toThrow("capstone failed: cap-path-escape");
  });

  it("parses the capstone fixture with budgets and file assertions", () => {
    const parsed = parseCapstoneCases(
      '{"id":"cap-crash-recovery","task":"恢复","expectedStatus":"completed","maxSteps":12,"maxToolCalls":9,"allowSideEffects":true,"expectedFiles":["README.md"]}\n',
    );

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      id: "cap-crash-recovery",
      maxSteps: 12,
      maxToolCalls: 9,
      allowSideEffects: true,
      expectedFiles: ["README.md"],
    });
    expect(() => parseCapstoneCases('{"id":"x"}')).toThrow("invalid capstone case");
  });
});
