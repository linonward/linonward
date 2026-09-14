import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("../src/content/task-planning.mdx", import.meta.url)),
  "utf8",
);

describe("task planning lesson", () => {
  it("turns a goal into an observable plan that can be executed and revised", () => {
    expect(source).toContain('id="separate-goal-plan-step"');
    expect(source).toContain('id="define-plan-state"');
    expect(source).toContain('id="create-initial-plan"');
    expect(source).toContain('id="advance-plan"');
    expect(source).toContain('id="replan-from-evidence"');
    expect(source).toContain('id="connect-plan-to-loop"');
    expect(source).toContain('status: "pending" | "in_progress" | "completed" | "blocked"');
    expect(source).toContain("acceptanceCriteria");
    expect(source).toContain("selectNextStep");
    expect(source).toContain("shouldReplan");
    expect(source).toContain("plan_revised");
    expect(source).toContain(`\`\`\`typescript
export interface AcceptanceCriterion {
  id: string;`);
    expect(source).not.toContain("<CodeBlock");
  });

  it("provides a self-contained verification path for the plan state machine", () => {
    expect(source).toContain("function updateStep(");
    expect(source).toContain("function createPlanFixture(): TaskPlan");
    expect(source).toContain('it("rejects a step whose dependency is unfinished"');
    expect(source).toContain('it("prevents two steps from running at once"');
    expect(source).toContain('it("requires evidence before completing a step"');
    expect(source).toContain('it("replans after repeated tool failures"');
    expect(source).toContain('it("preserves completed work when replanning"');
    expect(source).toContain('it("rejects early completion while criteria remain unverified"');
    expect(source).toContain("expect(revised.version).toBe(2)");
    expect(source).toContain("expect(allCriteriaPassed(unverified)).toBe(false)");
    expect(source).toContain("pnpm typecheck && pnpm test -- tests/plan.test.ts");
    expect(source).toContain("9 tests passed");
  });

  it("verifies planning with the tutorial's real engineering task", () => {
    expect(source).toContain('id="verify-real-task"');
    expect(source).toContain("export function createModelPlanCreator(");
    expect(source).toContain('const goal = process.argv.slice(2).join(" ").trim()');
    expect(source).toContain('pnpm dev -- "给示例 CLI 增加 --name 参数并补充测试"');
    expect(source).toContain("`plan.goal` 必须与命令中的任务原文完全一致");
    expect(source).toContain("这一步验证的是 Agent 对任务的规划能力");
    expect(source).toContain("前面章节已经分别验证文件修改和命令执行");
  });

  it("invalidates changed plan semantics and rejects duplicate ids", () => {
    expect(source).toContain("duplicate acceptance criterion id");
    expect(source).toContain("sameStepContract");
    expect(source).toContain("sameCriterionContract");
    expect(source).toContain("<LessonPart");
  });
});
