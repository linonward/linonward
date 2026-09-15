import { describe, expect, it } from "vitest";

import {
  allCriteriaPassed,
  completeStep,
  reconcilePlan,
  selectNextStep,
  shouldReplan,
  startStep,
} from "../src/plan.js";
import { createInitialPlan, validatePlan } from "../src/planner.js";
import type { AcceptanceCriterion, PlanStep, TaskPlan } from "../src/types.js";
import { ScriptedPlanner, makeDraft } from "./support.js";

function createPlanFixture(): TaskPlan {
  return {
    version: 1,
    goal: "修复登录失败并运行测试",
    acceptanceCriteria: [
      { id: "login-test-passes", description: "登录测试通过", status: "unverified" },
    ],
    steps: [
      {
        id: "reproduce",
        title: "复现登录失败",
        status: "pending",
        dependsOn: [],
        completionEvidence: "保存失败测试输出",
        evidence: [],
      },
      {
        id: "diagnose",
        title: "定位失败原因",
        status: "pending",
        dependsOn: ["reproduce"],
        completionEvidence: "记录根因和相关代码位置",
        evidence: [],
      },
    ],
  };
}

describe("plan state machine", () => {
  it("rejects a step whose dependency is unfinished", () => {
    const plan = createPlanFixture();

    expect(selectNextStep(plan)?.id).toBe("reproduce");
    expect(() => startStep(plan, "diagnose")).toThrow("step is not ready");
  });

  it("prevents two steps from running at once", () => {
    const running = startStep(createPlanFixture(), "reproduce");

    expect(() => startStep(running, "diagnose")).toThrow(
      "another plan step is already in progress",
    );
  });

  it("requires evidence before completing a step", () => {
    const running = startStep(createPlanFixture(), "reproduce");

    expect(() => completeStep(running, "reproduce", "   ")).toThrow(
      "completion evidence is required",
    );
  });

  it("replans after repeated tool failures", () => {
    expect(
      shouldReplan({
        userChangedGoal: false,
        failedAssumption: false,
        consecutiveToolFailures: 2,
        plan: createPlanFixture(),
      }),
    ).toBe("repeated_tool_failure");
  });

  it("preserves completed work when replanning", () => {
    const running = startStep(createPlanFixture(), "reproduce");
    const completed = completeStep(running, "reproduce", "login.test.ts fails with 401");
    const revised = reconcilePlan(
      completed,
      {
        acceptanceCriteria: [{ id: "login-test-passes", description: "登录测试通过" }],
        steps: [
          {
            id: "reproduce",
            title: "复现登录失败",
            dependsOn: [],
            completionEvidence: "保存失败测试输出",
          },
          {
            id: "diagnose",
            title: "检查认证服务返回值",
            dependsOn: ["reproduce"],
            completionEvidence: "记录根因和相关代码位置",
          },
        ],
      },
      "failed_assumption",
    );

    expect(revised.version).toBe(2);
    expect(revised.goal).toBe(completed.goal);
    expect(revised.steps[0]).toMatchObject({
      id: "reproduce",
      status: "completed",
      evidence: ["login.test.ts fails with 401"],
    });
  });

  it("invalidates completed work when the step contract changes", () => {
    const running = startStep(createPlanFixture(), "reproduce");
    const completed = completeStep(running, "reproduce", "saved failure output");
    const revised = reconcilePlan(
      completed,
      {
        acceptanceCriteria: [{ id: "login-test-passes", description: "登录测试通过" }],
        steps: [
          {
            id: "reproduce",
            title: "复现并定位登录失败",
            dependsOn: [],
            completionEvidence: "保存失败测试输出与根因",
          },
        ],
      },
      "failed_assumption",
    );

    expect(revised.steps[0]).toMatchObject({ status: "pending", evidence: [] });
  });

  it("invalidates passed criteria when their description changes", () => {
    const current = createPlanFixture();
    const criterion = current.acceptanceCriteria[0];
    if (!criterion) throw new Error("fixture criterion missing");
    current.acceptanceCriteria[0] = { ...criterion, status: "passed", evidence: "old evidence" };

    const revised = reconcilePlan(
      current,
      {
        acceptanceCriteria: [{ id: "login-test-passes", description: "登录和登出测试都通过" }],
        steps: current.steps,
      },
      "new_constraint",
    );

    expect(revised.acceptanceCriteria[0]).toEqual({
      id: "login-test-passes",
      description: "登录和登出测试都通过",
      status: "unverified",
    });
  });

  it("rejects duplicate acceptance criterion ids", () => {
    expect(() =>
      validatePlan({
        acceptanceCriteria: [
          { id: "same", description: "first" },
          { id: "same", description: "second" },
        ],
        steps: [{ id: "inspect", title: "Inspect", dependsOn: [], completionEvidence: "output" }],
      }),
    ).toThrow("duplicate acceptance criterion id");
  });

  it("rejects early completion while criteria remain unverified", () => {
    const plan = createPlanFixture();
    const unverified: TaskPlan = {
      ...plan,
      steps: plan.steps.map((step): PlanStep => ({ ...step, status: "completed" })),
    };

    expect(allCriteriaPassed(unverified)).toBe(false);

    const verified: TaskPlan = {
      ...unverified,
      acceptanceCriteria: unverified.acceptanceCriteria.map(
        (criterion): AcceptanceCriterion => ({
          ...criterion,
          status: "passed",
          evidence: "login.test.ts passed",
        }),
      ),
    };

    expect(allCriteriaPassed(verified)).toBe(true);
  });

  it("rejects empty plans, duplicate step ids, unknown dependencies and cycles", () => {
    expect(() =>
      validatePlan({ acceptanceCriteria: [{ id: "a", description: "a" }], steps: [] }),
    ).toThrow("plan requires at least one step");
    expect(() => validatePlan({ acceptanceCriteria: [], steps: [] })).toThrow(
      "plan requires at least one acceptance criterion",
    );
    expect(() =>
      validatePlan({
        acceptanceCriteria: [{ id: "a", description: "a" }],
        steps: [
          { id: "same", title: "a", dependsOn: [], completionEvidence: "e" },
          { id: "same", title: "b", dependsOn: [], completionEvidence: "e" },
        ],
      }),
    ).toThrow("duplicate step id");
    expect(() =>
      validatePlan({
        acceptanceCriteria: [{ id: "a", description: "a" }],
        steps: [{ id: "s1", title: "a", dependsOn: ["missing"], completionEvidence: "e" }],
      }),
    ).toThrow("unknown dependency in step: s1");
    expect(() =>
      validatePlan({
        acceptanceCriteria: [{ id: "a", description: "a" }],
        steps: [
          { id: "s1", title: "a", dependsOn: ["s2"], completionEvidence: "e" },
          { id: "s2", title: "b", dependsOn: ["s1"], completionEvidence: "e" },
        ],
      }),
    ).toThrow("plan contains a dependency cycle");
  });

  it("creates version 1 plans with pending steps and unverified criteria", async () => {
    const planner = new ScriptedPlanner(
      makeDraft({
        criteria: [{ id: "criterion-1", description: "任务结果可验证" }],
        steps: [{ id: "inspect", title: "调查仓库" }],
      }),
    );

    const plan = await createInitialPlan("目标", "上下文", ["read_file"], planner);

    expect(plan.version).toBe(1);
    expect(plan.steps[0]).toMatchObject({ id: "inspect", status: "pending", evidence: [] });
    expect(plan.acceptanceCriteria[0]).toMatchObject({ id: "criterion-1", status: "unverified" });
    expect(planner.createInputs[0]?.availableTools).toEqual(["read_file"]);
  });
});
