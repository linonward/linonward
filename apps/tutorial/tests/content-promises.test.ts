import { describe, expect, it } from "vitest";

import {
  checkpoint,
  componentProp,
  hasComponent,
  lessonSource,
  listProp,
} from "./support/lesson-source";

/**
 * 刻意逐字固定的内容承诺。
 *
 * 与 `lesson-structure.test.ts` 的分工：那边只验证教学结构与锚点，任何改文案都不该让它变红；
 * 这里只保留"读者被明确承诺过、且必须逐字准确"的少量句子。
 * 正文措辞需要大改时，请集中修改本文件，而不是把断言撒回各章测试。
 */
describe("content promises", () => {
  it("promises one cumulative agent-from-scratch project and the harness boundary", () => {
    const source = lessonSource("start");

    expect(source).toContain("同一个 `agent-from-scratch` 项目");
    for (const promise of ["理解组件", "Harness", "预算", "权限", "证据", "停止条件"]) {
      expect(source, `start should keep the ${promise} promise`).toContain(promise);
    }
    expect(source, "start must warn against unpinned versions").not.toContain('"latest"');
  });

  it("points readers at the extension track without making it a prerequisite", () => {
    const source = lessonSource("start");

    expect(source).toContain("扩展篇");
    expect(source).toContain("](/extensions)");
    expect(source).toContain("不是主线 Capstone 的前置条件");
  });

  it("keeps the offline path and the cost warning ahead of any paid call", () => {
    const source = lessonSource("model-call");
    const goal = componentProp(source, "LessonOverview", "goal") ?? "";

    expect(goal, "the chapter goal must promise an offline path").toContain("离线");
    expect(source).toContain("FakeModel");
    expect(source).toContain("费用");
    expect(source).toContain("能力要求");
  });

  it("keeps the capstone task identical to the goal written in chapter 00", () => {
    const start = lessonSource("start");
    const capstone = lessonSource("capstone");
    const permissions = lessonSource("permissions-safety");

    expect(start).toContain("给示例 CLI 增加 --name 参数并补充测试");
    expect(capstone).toContain('title="完成贯穿教程的真实任务"');
    expect(capstone).toContain("给 CLI 增加 --name 参数，并补充测试");
    expect(permissions).not.toContain('title="完成贯穿教程的真实任务"');
  });

  it("keeps planning verification pinned to the real engineering task", () => {
    const source = lessonSource("task-planning");

    expect(source).toContain("9 tests passed");
    expect(source).toContain("`plan.goal` 必须与命令中的任务原文完全一致");
    expect(source).toContain("这一步验证的是 Agent 对任务的规划能力");
    expect(source).toContain("前面章节已经分别验证文件修改和命令执行");
  });

  it("name the trace, evaluation, and capstone fixtures in the chapter file lists", () => {
    const observability = lessonSource("observability-evaluation");
    const capstone = lessonSource("capstone");

    expect(listProp(observability, "LessonOverview", "files")).toContain("evals/cases.jsonl");
    expect(listProp(capstone, "LessonOverview", "files")).toContain("evals/capstone.jsonl");
    expect(checkpoint(observability)?.command).toContain("tests/eval.test.ts");
    expect(checkpoint(capstone)?.command).toContain("tests/capstone.test.ts");
  });

  it("keeps the safety grading vocabulary that the evaluator depends on", () => {
    const observability = lessonSource("observability-evaluation");
    const capstone = lessonSource("capstone");

    expect(observability).toContain("确定性 grader");
    expect(observability).toContain("安全回归门禁");
    expect(capstone).toContain("请求澄清");
    expect(capstone).toContain("Prompt injection");
    expect(capstone).toContain("副作用只发生一次");
    expect(capstone).toContain("correctlyBlockedCases");
  });

  it("keeps the interactive diagram wired into the loop chapter", () => {
    expect(hasComponent(lessonSource("agent-loop"), "AgentLoopDiagram")).toBe(true);
  });
});
