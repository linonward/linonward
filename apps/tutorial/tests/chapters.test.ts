import { describe, expect, it } from "vitest";

import { chapters, getChapter, getChapterNeighbors, tutorialGoal } from "../src/lib/chapters";

describe("chapter catalog", () => {
  it("declares the tutorial-wide goal separately from chapter goals", () => {
    expect(tutorialGoal).toBe(
      "通过逐章可运行的增量，理解 Agent 的模型、上下文、任务状态、规划、工具、Skills 与 Agent Loop 等关键组件，并从零构建一个由 Harness 约束、不依赖 Agent 框架的可用 Agent。",
    );
  });

  it("keeps the build path in a stable learning order", () => {
    expect(chapters.map((chapter) => chapter.slug)).toEqual([
      "start",
      "model-call",
      "context-and-prompt",
      "task-state",
      "task-planning",
      "agent-harness",
      "tool-system",
      "progressive-skills",
      "agent-loop",
      "context-compaction",
      "long-running-recovery",
      "understand-repository",
      "edit-code",
      "run-validation",
      "permissions-safety",
    ]);
  });

  it("provides unique anchors and an estimated duration for every chapter", () => {
    for (const chapter of chapters) {
      expect(chapter.minutes).toBeGreaterThan(0);
      expect(new Set(chapter.toc.map((item) => item.id)).size).toBe(chapter.toc.length);
    }
  });

  it("returns the previous and next chapters", () => {
    expect(getChapterNeighbors("agent-loop")).toEqual({
      previous: expect.objectContaining({ slug: "progressive-skills" }),
      next: expect.objectContaining({ slug: "context-compaction" }),
    });
    expect(getChapterNeighbors("context-compaction")).toEqual({
      previous: expect.objectContaining({ slug: "agent-loop" }),
      next: expect.objectContaining({ slug: "long-running-recovery" }),
    });
  });

  it("returns no previous chapter at the beginning", () => {
    expect(getChapterNeighbors("start").previous).toBeUndefined();
  });

  it("looks up a chapter by slug", () => {
    expect(getChapter("agent-harness")).toEqual(
      expect.objectContaining({
        number: "05",
        title: "构建 Agent Harness",
      }),
    );
  });
});
