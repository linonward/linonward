import { describe, expect, it } from "vitest";

import { codeText, checkpoint, lessonSource, listProp, stepIds } from "./support/lesson-source";

const source = lessonSource("task-planning");
const code = codeText(source);

describe("task planning lesson", () => {
  it("turns a goal into an observable plan that can be executed and revised", () => {
    expect(stepIds(source)).toEqual(
      expect.arrayContaining([
        "separate-goal-plan-step",
        "define-plan-state",
        "create-initial-plan",
        "advance-plan",
        "replan-from-evidence",
        "connect-plan-to-loop",
      ]),
    );
    for (const marker of [
      'status: "pending" | "in_progress" | "completed" | "blocked"',
      "acceptanceCriteria",
      "selectNextStep",
      "shouldReplan",
      "duplicate acceptance criterion id",
      "sameStepContract",
      "sameCriterionContract",
    ]) {
      expect(code, `task planning should keep ${marker}`).toContain(marker);
    }
  });

  it("ships a self-contained verification path for the plan state machine", () => {
    for (const marker of [
      "function updateStep(",
      "function createPlanFixture(): TaskPlan",
      'it("rejects a step whose dependency is unfinished"',
      'it("prevents two steps from running at once"',
      'it("requires evidence before completing a step"',
      'it("replans after repeated tool failures"',
      'it("preserves completed work when replanning"',
      'it("rejects early completion while criteria remain unverified"',
      "expect(revised.version).toBe(2)",
      "expect(allCriteriaPassed(unverified)).toBe(false)",
    ]) {
      expect(code, `plan tests should keep ${marker}`).toContain(marker);
    }
    expect(checkpoint(source)?.command).toContain("tests/plan.test.ts");
  });

  it("verifies planning with the tutorial's real engineering task", () => {
    expect(stepIds(source)).toContain("verify-real-task");
    for (const marker of [
      "export function createModelPlanCreator(",
      'const goal = process.argv.slice(2).join(" ").trim()',
      'pnpm dev -- "给示例 CLI 增加 --name 参数并补充测试"',
    ]) {
      expect(code, `planning verification should keep ${marker}`).toContain(marker);
    }
    expect(listProp(source, "LessonOverview", "files")).toContain("tests/plan.test.ts");
  });

  it("groups the three labs as collapsible lesson parts", () => {
    for (const partId of ["plan-generation", "plan-progress", "plan-verification"]) {
      expect(source, `task planning should keep the ${partId} lab`).toMatch(
        new RegExp(`<LessonPart id="${partId}"`),
      );
    }
  });
});
