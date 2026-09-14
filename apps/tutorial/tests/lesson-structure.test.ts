import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const contentDirectory = fileURLToPath(new URL("../src/content", import.meta.url));
const lessonFiles = readdirSync(contentDirectory).filter((file) => file.endsWith(".mdx"));

describe("step-by-step lessons", () => {
  it("gives every chapter an outcome, numbered steps, and a checkpoint", () => {
    expect(lessonFiles).toHaveLength(13);

    for (const file of lessonFiles) {
      const source = readFileSync(`${contentDirectory}/${file}`, "utf8");

      expect(source, `${file} should declare its outcome`).toContain("<LessonOverview");
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
});
