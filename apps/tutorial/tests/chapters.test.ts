import { describe, expect, it } from "vitest";

import {
  chapters,
  getChapter,
  getChapterNeighbors,
  tutorialExtensions,
  tutorialGoal,
} from "../src/lib/chapters";

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
      "agent-harness",
      "tool-system",
      "understand-repository",
      "edit-code",
      "run-validation",
      "task-state",
      "permissions-safety",
      "task-planning",
      "user-interaction",
      "progressive-skills",
      "observability-evaluation",
      "agent-loop",
      "context-compaction",
      "long-running-recovery",
      "capstone",
    ]);
  });

  it("keeps framework integrations and distributed orchestration outside the core path", () => {
    expect(tutorialExtensions.map((extension) => extension.id)).toEqual([
      "multi-agent",
      "mcp",
      "rag",
      "browser-automation",
      "voice",
      "parallel-orchestration",
    ]);
    expect(chapters.every((chapter) => chapter.track === "core")).toBe(true);
    expect(chapters.at(-1)).toEqual(expect.objectContaining({ slug: "capstone" }));
  });

  it("delivers a useful repository agent before advanced orchestration topics", () => {
    const slugs = chapters.map((chapter) => chapter.slug);
    const repositoryReadingIndex = slugs.indexOf("understand-repository");
    const minutesBeforeRepositoryReading = chapters
      .slice(0, repositoryReadingIndex)
      .reduce((total, chapter) => total + chapter.minutes, 0);

    expect(repositoryReadingIndex).toBeLessThan(slugs.indexOf("task-planning"));
    expect(repositoryReadingIndex).toBeLessThan(slugs.indexOf("progressive-skills"));
    expect(repositoryReadingIndex).toBeLessThan(slugs.indexOf("context-compaction"));
    expect(slugs.indexOf("task-state")).toBeGreaterThan(slugs.indexOf("run-validation"));
    expect(slugs.indexOf("user-interaction")).toBeLessThan(slugs.indexOf("progressive-skills"));
    expect(slugs.indexOf("observability-evaluation")).toBeLessThan(
      slugs.indexOf("context-compaction"),
    );
    expect(slugs.at(-1)).toBe("capstone");
    expect(minutesBeforeRepositoryReading).toBeLessThanOrEqual(150);
  });

  it("provides unique anchors and an estimated duration for every chapter", () => {
    for (const chapter of chapters) {
      expect(chapter.minutes).toBeGreaterThan(0);
      expect(new Set(chapter.toc.map((item) => item.id)).size).toBe(chapter.toc.length);
    }
  });

  it("returns the previous and next chapters", () => {
    expect(getChapterNeighbors("agent-loop")).toEqual({
      previous: expect.objectContaining({ slug: "observability-evaluation" }),
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
        number: "03",
        title: "最小 Agent Loop",
      }),
    );
  });
});
