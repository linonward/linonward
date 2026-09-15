import { describe, expect, it } from "vitest";

import type { Model } from "../src/model.js";
import type { PlanDraft } from "../src/planner.js";
import { createModelPlanner, filterEvidenceFromObservations } from "../src/planner-model.js";
import type { PlanStep } from "../src/types.js";

const DRAFT: PlanDraft = {
  acceptanceCriteria: [{ id: "criterion-1", description: "README 第一行已修改" }],
  steps: [
    {
      id: "step-1",
      title: "修改并验证 README",
      dependsOn: [],
      completionEvidence: "apply_patch 结果与 run_command 输出",
    },
  ],
};

const REVISED_DRAFT: PlanDraft = {
  acceptanceCriteria: [
    { id: "criterion-1", description: "README 第一行已修改" },
    { id: "criterion-2", description: "验证命令通过" },
  ],
  steps: [
    {
      id: "step-1",
      title: "修改 README",
      dependsOn: [],
      completionEvidence: "apply_patch 结果",
    },
    {
      id: "step-2",
      title: "运行验证命令",
      dependsOn: ["step-1"],
      completionEvidence: "run_command 输出",
    },
  ],
};

const STEP: PlanStep = {
  id: "step-1",
  title: "修改并验证 README",
  status: "in_progress",
  dependsOn: [],
  completionEvidence: "apply_patch 结果与 run_command 输出",
  evidence: [],
};

/** 脚本化 `Model`：按顺序返回预设文本，并记录每次请求的 instructions。 */
function scriptedModel(replies: string[]): { model: Model; instructions: string[] } {
  const instructions: string[] = [];

  return {
    instructions,
    model: {
      async generate(request) {
        instructions.push(request.instructions);
        const next = replies.shift();
        if (next === undefined) throw new Error("scripted model ran out of replies");
        return next;
      },
    },
  };
}

function captureThrow(run: () => Promise<unknown>): Promise<unknown> {
  return run().catch((error: unknown) => error);
}

describe("createModelPlanner", () => {
  it("creates a plan by validating the model JSON draft", async () => {
    const { model } = scriptedModel([JSON.stringify(DRAFT)]);
    const planner = createModelPlanner(model);

    await expect(
      planner.create({
        goal: "把 README 第一行改成 # Hello Agent",
        context: "workspace_rule:AGENTS.md",
        availableTools: ["read_file", "search_text", "apply_patch", "run_command"],
      }),
    ).resolves.toEqual(DRAFT);
  });

  it("rejects an invalid plan draft from create", async () => {
    const { model } = scriptedModel([JSON.stringify({ acceptanceCriteria: [], steps: [] })]);
    const planner = createModelPlanner(model);

    await expect(planner.create({ goal: "g", context: "c", availableTools: [] })).rejects.toThrow(
      "plan requires at least one acceptance criterion",
    );
  });

  it("revises a plan with a Chinese contract and no Markdown fences", async () => {
    const { model, instructions } = scriptedModel([JSON.stringify(REVISED_DRAFT)]);
    const planner = createModelPlanner(model);

    const draft = await planner.revise({
      current: { version: 1, goal: "g", acceptanceCriteria: [], steps: [] },
      reason: "repeated_tool_failure",
      observations: ["{}"],
    });

    expect(draft).toEqual(REVISED_DRAFT);
    const used = instructions[0] ?? "";
    expect(used).toContain("不要输出 Markdown 代码围栏");
    expect(used).toContain("acceptanceCriteria");
    expect(used).toContain("修订计划");
  });

  it("revise throws a clear error when the model returns invalid JSON", async () => {
    const { model } = scriptedModel(["```json\n{}\n```"]);
    const planner = createModelPlanner(model);

    await expect(
      planner.revise({
        current: { version: 1, goal: "g", acceptanceCriteria: [], steps: [] },
        reason: "no_ready_step",
        observations: [],
      }),
    ).rejects.toThrow("revise返回了非法 JSON");
  });

  it("evaluates progress and drops evidence the model made up", async () => {
    const model: Model = {
      async generate() {
        return JSON.stringify({
          completed: true,
          evidence: ["工具返回 ok=true", '{"ok":true,"data":"real"}'],
          passedCriteria: ["criterion-1"],
        });
      },
    };
    const planner = createModelPlanner(model);

    const evaluation = await planner.evaluate({
      step: STEP,
      observations: ['{"ok":true,"data":"real"}'],
    });

    expect(evaluation).toEqual({
      completed: true,
      evidence: ['{"ok":true,"data":"real"}'],
      passedCriteria: ["criterion-1"],
    });
  });

  it("keeps the latest observations only when maxObservations is set", async () => {
    const seen: string[] = [];
    const model: Model = {
      async generate(request) {
        const payload = JSON.parse(String(request.input[0]?.content)) as {
          observations: string[];
        };
        seen.push(...payload.observations);
        return JSON.stringify({ completed: false, evidence: [], passedCriteria: [] });
      },
    };
    const planner = createModelPlanner(model, { maxObservations: 2 });

    await planner.evaluate({ step: STEP, observations: ["o1", "o2", "o3"] });

    expect(seen).toEqual(["o2", "o3"]);
  });

  it("accepts a documented replanReason and rejects unknown ones", async () => {
    const ok = scriptedModel([
      JSON.stringify({
        completed: false,
        evidence: [],
        passedCriteria: [],
        replanReason: "no_ready_step",
      }),
    ]);
    const planner = createModelPlanner(ok.model);
    await expect(planner.evaluate({ step: STEP, observations: [] })).resolves.toEqual({
      completed: false,
      evidence: [],
      passedCriteria: [],
      replanReason: "no_ready_step",
    });

    const bad = scriptedModel([
      JSON.stringify({
        completed: false,
        evidence: [],
        passedCriteria: [],
        replanReason: "because",
      }),
    ]);
    await expect(
      createModelPlanner(bad.model).evaluate({ step: STEP, observations: [] }),
    ).rejects.toThrow("未知的 replanReason");
  });

  it("throws a clear error for malformed evaluate JSON and shapes", async () => {
    const invalidJson = scriptedModel(["not json at all"]);
    await expect(
      createModelPlanner(invalidJson.model).evaluate({ step: STEP, observations: [] }),
    ).rejects.toThrow("evaluate返回了非法 JSON");

    const wrongShape = scriptedModel([JSON.stringify({ completed: "yes", evidence: [] })]);
    await expect(
      createModelPlanner(wrongShape.model).evaluate({ step: STEP, observations: [] }),
    ).rejects.toThrow("completed 必须是布尔值");

    const nonObject = scriptedModel(['["completed"]']);
    const thrown = await captureThrow(() =>
      createModelPlanner(nonObject.model).evaluate({ step: STEP, observations: [] }),
    );
    expect(thrown).toBeInstanceOf(Error);
    if (!(thrown instanceof Error)) throw new Error("expected Error");
    expect(thrown.message).toContain("必须返回一个 JSON 对象");
  });

  it("filters evidence by exact observation membership", () => {
    expect(
      filterEvidenceFromObservations(
        ["a", "a plus more", '{"ok":true}', "a"],
        ["a", '{"ok":true}', "b"],
      ),
    ).toEqual(["a", '{"ok":true}', "a"]);
  });
});
