import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { chapters } from "../src/lib/chapters";
import { checkpoint, lessonSource } from "./support/lesson-source";

/**
 * 教程与可执行 fixture 之间的契约。
 *
 * 教程每章的 Checkpoint 会让读者运行某个命令。这个文件保证：
 * 1. Checkpoint 点名的 `tests/*.test.ts` 在 `packages/agent-from-scratch-fixture` 里真的存在；
 * 2. 没有点名测试文件的章节，其 Checkpoint 至少能在这份参考实现里执行（`pnpm check` / `pnpm test` / `pnpm dev`）；
 * 3. fixture 保持离线：不依赖厂商 SDK。
 *
 * 这样"教程里写的代码能不能跑"就不再只靠正文的字符串断言，而是有一个可编译、可测试的实体兜底。
 */
const fixtureDirectory = fileURLToPath(
  new URL("../../../packages/agent-from-scratch-fixture", import.meta.url),
);

function testFilesReferencedBy(command: string): string[] {
  return [
    ...new Set([...command.matchAll(/tests\/[a-z0-9-]+\.test\.ts/g)].map((match) => match[0])),
  ];
}

function fixtureTestFiles(): string[] {
  return readdirSync(`${fixtureDirectory}/tests`).filter((file) => file.endsWith(".test.ts"));
}

describe("executable fixture coverage", () => {
  it("ships the reference project the tutorial keeps referring to", () => {
    expect(existsSync(`${fixtureDirectory}/package.json`)).toBe(true);
    expect(existsSync(`${fixtureDirectory}/src/agent-loop.ts`)).toBe(true);
    expect(existsSync(`${fixtureDirectory}/src/state.ts`)).toBe(true);
    expect(existsSync(`${fixtureDirectory}/src/plan.ts`)).toBe(true);
    expect(existsSync(`${fixtureDirectory}/README.md`)).toBe(true);
  });

  it("provides every test file a chapter checkpoint tells the reader to run", () => {
    const available = new Set(fixtureTestFiles());

    for (const chapter of chapters) {
      const command = checkpoint(lessonSource(chapter.slug))?.command ?? "";
      const referenced = testFilesReferencedBy(command);

      for (const file of referenced) {
        expect(
          available.has(file.replace(/^tests\//, "")),
          `${chapter.slug} asks the reader to run ${file}, but the fixture does not ship it`,
        ).toBe(true);
      }
    }
  });

  it("lets every chapter checkpoint run inside the fixture", () => {
    for (const chapter of chapters) {
      const command = checkpoint(lessonSource(chapter.slug))?.command ?? "";

      expect(
        /pnpm (check|test|dev)\b/.test(command),
        `${chapter.slug} checkpoint is not runnable in the fixture: ${command}`,
      ).toBe(true);
    }
  });

  it("keeps the fixture offline and free of vendor SDKs", () => {
    const manifest = JSON.parse(readFileSync(`${fixtureDirectory}/package.json`, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });

    expect(declared).not.toContain("openai");
    expect(declared).not.toContain("@modelcontextprotocol/sdk");
  });
});
