import { describe, expect, it } from "vitest";

import { chapters } from "../src/lib/chapters";
import {
  anchors,
  checkpoint,
  codeBlocks,
  componentProp,
  hasCheckpointAfterLastStep,
  lessonFiles,
  lessonSource,
  listProp,
  stepBodies,
  stepIds,
  stepNumbers,
} from "./support/lesson-source";

/**
 * 主线的结构性契约。
 *
 * 这些断言只依赖教学 DSL（LessonOverview / Step / Checkpoint / 代码块）与章节目录，
 * 不依赖任何一句正文措辞：改文案不应该让这个文件变红。
 * 需要逐字固定的内容承诺集中在 `content-promises.test.ts`。
 */
describe("step-by-step lesson contract", () => {
  it("ships exactly one MDX lesson per registered core chapter", () => {
    expect(lessonFiles().map((file) => file.replace(/\.mdx$/, ""))).toEqual(
      chapters.map((chapter) => chapter.slug).toSorted(),
    );
  });

  it("declares a goal, a task, prerequisites, and the files it touches", () => {
    for (const chapter of chapters) {
      const source = lessonSource(chapter.slug);
      const goal = componentProp(source, "LessonOverview", "goal");
      const task = componentProp(source, "LessonOverview", "task");
      const prerequisites = componentProp(source, "LessonOverview", "prerequisites");
      const files = listProp(source, "LessonOverview", "files");

      expect(goal, `${chapter.slug} should declare its goal`).toBeDefined();
      expect(task, `${chapter.slug} should declare its task`).toBeDefined();
      expect(prerequisites, `${chapter.slug} should declare its prerequisites`).toBeDefined();
      expect(goal?.length ?? 0, `${chapter.slug} goal is too short`).toBeGreaterThan(20);
      expect(task?.length ?? 0, `${chapter.slug} task is too short`).toBeGreaterThan(10);
      expect(files.length, `${chapter.slug} should list at least one touched file`).toBeGreaterThan(
        0,
      );
    }
  });

  it("numbers steps continuously, uniquely, and with a real body each", () => {
    for (const chapter of chapters) {
      const source = lessonSource(chapter.slug);
      const numbers = stepNumbers(source);
      const bodies = stepBodies(source);

      expect(
        numbers.length,
        `${chapter.slug} should teach in several steps`,
      ).toBeGreaterThanOrEqual(3);
      expect(numbers, `${chapter.slug} should number steps continuously`).toEqual(
        Array.from({ length: numbers.length }, (_, index) => index + 1),
      );
      expect(new Set(stepIds(source)).size, `${chapter.slug} has duplicate step ids`).toBe(
        numbers.length,
      );
      for (const step of bodies) {
        expect(step.body.trim().length, `${chapter.slug}#${step.id} is empty`).toBeGreaterThan(60);
      }
    }
  });

  it("keeps the registered table of contents aligned with body anchors, in order", () => {
    for (const chapter of chapters) {
      const source = lessonSource(chapter.slug);
      const body = anchors(source);
      const tocIds = chapter.toc.map((item) => item.id);

      expect(new Set(body).size, `${chapter.slug} has duplicate body anchors`).toBe(body.length);
      expect(new Set(tocIds).size, `${chapter.slug} has duplicate toc ids`).toBe(tocIds.length);

      for (const id of tocIds) {
        expect(body, `${chapter.slug}#${id} has no anchor`).toContain(id);
      }
      expect(
        body.filter((id) => tocIds.includes(id)),
        `${chapter.slug} anchors should follow the toc order`,
      ).toEqual(tocIds);
    }
  });

  it("ends every chapter with a runnable checkpoint", () => {
    for (const chapter of chapters) {
      const source = lessonSource(chapter.slug);
      const found = checkpoint(source);

      expect(found, `${chapter.slug} should contain a checkpoint`).toBeDefined();
      expect(hasCheckpointAfterLastStep(source), `${chapter.slug} checkpoint position`).toBe(true);
      expect(
        found?.command.trim().length ?? 0,
        `${chapter.slug} checkpoint command`,
      ).toBeGreaterThan(8);
      expect(
        found?.body.trim().length ?? 0,
        `${chapter.slug} checkpoint expectations`,
      ).toBeGreaterThan(40);
    }
  });

  it("teaches through runnable code fences instead of prose only", () => {
    for (const chapter of chapters) {
      const source = lessonSource(chapter.slug);
      const fences = codeBlocks(source);
      const languages = [...source.matchAll(/```([\w-]+)\r?\n/g)].map((match) => match[1]);

      expect(fences.length, `${chapter.slug} should ship runnable blocks`).toBeGreaterThanOrEqual(
        3,
      );
      expect(
        languages.filter((language) => language === "typescript").length,
        `${chapter.slug} should ship TypeScript increments`,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it("keeps the core path independent from the extension track", () => {
    for (const chapter of chapters) {
      const source = lessonSource(chapter.slug);

      expect(source, `${chapter.slug} must not import extension content`).not.toContain(
        "content/extensions",
      );
      expect(source, `${chapter.slug} must not require an extension step`).not.toMatch(
        /必须先完成(多 Agent|MCP|RAG|浏览器操作|语音|复杂并行调度)/,
      );
    }
  });
});
