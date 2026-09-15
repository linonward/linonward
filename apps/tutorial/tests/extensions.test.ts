import { describe, expect, it } from "vitest";

import { chapters } from "../src/lib/chapters";
import {
  extensionChapters,
  getExtensionChapter,
  getExtensionNeighbors,
} from "../src/lib/extensions";
import {
  anchors,
  componentProp,
  extensionFiles,
  extensionSource,
  hasCheckpointAfterLastStep,
  stepIds,
  stepNumbers,
  steps,
} from "./support/lesson-source";

describe("extension track catalog", () => {
  it("exposes the six extension topics in a stable order", () => {
    expect(extensionChapters.map((chapter) => chapter.slug)).toEqual([
      "multi-agent",
      "mcp",
      "rag",
      "browser-automation",
      "voice",
      "parallel-orchestration",
    ]);
    expect(extensionChapters.every((chapter) => chapter.track === "extension")).toBe(true);
    expect(extensionChapters.map((chapter) => chapter.number)).toEqual([
      "E01",
      "E02",
      "E03",
      "E04",
      "E05",
      "E06",
    ]);
  });

  it("keeps extension slugs and anchors disjoint from the core path", () => {
    const coreSlugs = new Set(chapters.map((chapter) => chapter.slug));
    const coreAnchors = new Set(chapters.flatMap((chapter) => chapter.toc.map((item) => item.id)));

    for (const chapter of extensionChapters) {
      expect(coreSlugs.has(chapter.slug), `${chapter.slug} must not shadow a core slug`).toBe(
        false,
      );
      expect(chapter.minutes).toBeGreaterThan(0);
      expect(chapter.prerequisites.trim().length).toBeGreaterThan(0);
      expect(chapter.description.trim().length).toBeGreaterThan(0);
      expect(new Set(chapter.toc.map((item) => item.id)).size).toBe(chapter.toc.length);
      for (const item of chapter.toc) {
        expect(coreAnchors.has(item.id), `${chapter.slug} reuses core anchor ${item.id}`).toBe(
          false,
        );
      }
    }
  });

  it("does not let one extension depend on another extension", () => {
    const titles = extensionChapters.map((chapter) => chapter.title);

    for (const chapter of extensionChapters) {
      for (const title of titles) {
        if (title === chapter.title) continue;
        expect(chapter.prerequisites).not.toContain(title);
      }
    }
  });

  it("links extension neighbors within the extension track", () => {
    expect(getExtensionChapter("rag")?.title).toBe("RAG 与知识库");
    expect(getExtensionNeighbors("multi-agent")).toEqual({
      previous: undefined,
      next: expect.objectContaining({ slug: "mcp" }),
    });
    expect(getExtensionNeighbors("parallel-orchestration")).toEqual({
      previous: expect.objectContaining({ slug: "voice" }),
      next: undefined,
    });
  });
});

describe("extension lessons", () => {
  it("ships one MDX lesson per registered extension chapter", () => {
    const files = extensionFiles();

    expect(files).toHaveLength(extensionChapters.length);
    expect(files.map((file) => file.replace(/\.mdx$/, ""))).toEqual(
      extensionChapters.map((chapter) => chapter.slug).toSorted(),
    );
  });

  it("gives every extension the same goal, task, prerequisites, and files contract", () => {
    for (const chapter of extensionChapters) {
      const source = extensionSource(chapter.slug);

      expect(componentProp(source, "LessonOverview", "goal"), chapter.slug).toBeDefined();
      expect(componentProp(source, "LessonOverview", "task"), chapter.slug).toBeDefined();
      expect(componentProp(source, "LessonOverview", "prerequisites"), chapter.slug).toBeDefined();
      expect(source, `${chapter.slug} should declare its files`).toMatch(
        /<LessonOverview[\s\S]*?files=\{\[[\s\S]*?\]\}/,
      );
      expect(source, `${chapter.slug} should mention it is not a capstone prerequisite`).toContain(
        "Capstone",
      );
    }
  });

  it("numbers steps continuously and matches the registered table of contents", () => {
    for (const chapter of extensionChapters) {
      const source = extensionSource(chapter.slug);
      const numbers = stepNumbers(source);

      expect(numbers, `${chapter.slug} should number steps continuously`).toEqual(
        Array.from({ length: numbers.length }, (_, index) => index + 1),
      );
      expect(stepIds(source), `${chapter.slug} toc must match its steps`).toEqual(
        chapter.toc.map((item) => item.id),
      );
      expect(
        steps(source).map((step) => step.title),
        `${chapter.slug} step titles must match the registered toc titles`,
      ).toEqual(chapter.toc.map((item) => item.title));
      expect(
        stepIds(source).length,
        `${chapter.slug} should have at least four steps`,
      ).toBeGreaterThanOrEqual(4);

      for (const step of steps(source)) {
        expect(step.title.trim().length, `${chapter.slug}#${step.id}`).toBeGreaterThan(0);
      }
    }
  });

  it("places every table-of-contents anchor in the lesson body in order", () => {
    for (const chapter of extensionChapters) {
      const source = extensionSource(chapter.slug);
      const body = anchors(source);
      const tocIds = chapter.toc.map((item) => item.id);

      for (const id of tocIds) {
        expect(body, `${chapter.slug}#${id} has no anchor`).toContain(id);
      }

      const ordered = body.filter((id) => tocIds.includes(id));
      expect(ordered, `${chapter.slug} anchors should follow the toc order`).toEqual(tocIds);
    }
  });

  it("ends every extension with a runnable checkpoint", () => {
    for (const chapter of extensionChapters) {
      const source = extensionSource(chapter.slug);

      expect(source, `${chapter.slug} should contain a checkpoint`).toContain("<Checkpoint");
      expect(hasCheckpointAfterLastStep(source), `${chapter.slug} checkpoint position`).toBe(true);
      expect(source, `${chapter.slug} checkpoint should run a command`).toMatch(
        /<Checkpoint command=['"][^'"]+['"]>/,
      );
    }
  });

  it("teaches with TypeScript increments instead of prose only", () => {
    for (const chapter of extensionChapters) {
      const source = extensionSource(chapter.slug);
      const fences = [...source.matchAll(/```(typescript|json|shell|text)/g)].map(
        (match) => match[1],
      );

      expect(fences, `${chapter.slug} should include a TypeScript increment`).toContain(
        "typescript",
      );
      expect(
        fences.length,
        `${chapter.slug} should include several runnable blocks`,
      ).toBeGreaterThanOrEqual(5);
    }
  });

  it("keeps extension code as strict as the main path", () => {
    const forbidden = [
      { pattern: /\bany\b/, label: "any" },
      { pattern: /@ts-ignore|@ts-expect-error/, label: "type-check escape hatch" },
      { pattern: /as unknown as/, label: "double assertion" },
      { pattern: /from "openai"|from "playwright"|playwright-core/, label: "vendor SDK import" },
      { pattern: /pnpm (add|install)\b/, label: "install instruction inside code" },
    ];

    for (const chapter of extensionChapters) {
      const code = [...extensionSource(chapter.slug).matchAll(/```[\w-]*\r?\n([\s\S]*?)```/g)]
        .map((match) => match[1] ?? "")
        .join("\n");

      for (const { pattern, label } of forbidden) {
        expect(pattern.test(code), `${chapter.slug} should not use ${label} in code blocks`).toBe(
          false,
        );
      }
    }
  });

  it("places new context sources on the main-path priority ladder", () => {
    const ladder = new Set([80, 85, 90, 94, 95, 96, 98, 99, 100]);

    for (const chapter of extensionChapters) {
      const code = [...extensionSource(chapter.slug).matchAll(/```[\w-]*\r?\n([\s\S]*?)```/g)]
        .map((match) => match[1] ?? "")
        .join("\n");

      for (const match of code.matchAll(/priority:\s*(\d+)/g)) {
        expect(
          ladder.has(Number(match[1])),
          `${chapter.slug} uses priority ${match[1]}, which is not on the main-path ladder`,
        ).toBe(true);
      }
    }
  });
});
