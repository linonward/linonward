import { describe, expect, it } from "vitest";

import { chapters, getChapter, getChapterNeighbors } from "../src/lib/chapters";

describe("chapter catalog", () => {
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
