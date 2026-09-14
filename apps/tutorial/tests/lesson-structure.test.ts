import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const contentDirectory = fileURLToPath(new URL("../src/content", import.meta.url));
const lessonFiles = readdirSync(contentDirectory).filter((file) => file.endsWith(".mdx"));

describe("step-by-step lessons", () => {
  it("gives every chapter a goal, task, numbered steps, and checkpoint", () => {
    expect(lessonFiles).toHaveLength(15);

    for (const file of lessonFiles) {
      const source = readFileSync(`${contentDirectory}/${file}`, "utf8");

      expect(source, `${file} should declare its chapter goal`).toMatch(
        /<LessonOverview[\s\S]*?\n\s+goal="[^"]+"[\s\S]*?\/>/,
      );
      expect(source, `${file} should declare one concrete chapter task`).toMatch(
        /<LessonOverview[\s\S]*?\n\s+task="[^"]+"[\s\S]*?\/>/,
      );
      expect(source, `${file} should contain numbered steps`).toContain("<Step");
      expect(source, `${file} should end with a runnable checkpoint`).toContain("<Checkpoint");

      const numbers = [...source.matchAll(/<Step[^>]*number=\{(\d+)\}/g)].map((match) =>
        Number(match[1]),
      );
      expect(numbers, `${file} should number steps continuously`).toEqual(
        Array.from({ length: numbers.length }, (_, index) => index + 1),
      );
      expect(
        source.indexOf("<Checkpoint"),
        `${file} should place its checkpoint after the steps`,
      ).toBeGreaterThan(source.lastIndexOf("</Step>"));
    }
  });

  it("starts with an explicit build, understand, constrain, and verify contract", () => {
    const source = readFileSync(`${contentDirectory}/start.mdx`, "utf8");

    expect(source).toContain('id="understand-learning-path"');
    expect(source).toContain("同一个 `agent-from-scratch` 项目");
    expect(source).toContain("理解组件");
    expect(source).toContain("Harness");
    expect(source).toContain("状态");
    expect(source).toContain("预算");
    expect(source).toContain("权限");
    expect(source).toContain("证据");
    expect(source).toContain("停止条件");
    expect(source).not.toContain('"latest"');
  });

  it("provides a reproducible offline path before requiring a paid model call", () => {
    const source = readFileSync(`${contentDirectory}/model-call.mdx`, "utf8");

    expect(source).toContain("FakeModel");
    expect(source).toContain("离线");
    expect(source).toContain("费用");
    expect(source).toContain("能力要求");
  });
});
