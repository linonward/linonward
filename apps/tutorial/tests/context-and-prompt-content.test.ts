import { describe, expect, it } from "vitest";

import { checkpoint, codeText, lessonSource, listProp } from "./support/lesson-source";

const source = lessonSource("context-and-prompt");
const code = codeText(source);

describe("context and prompt lesson", () => {
  it("ships a runnable test suite for context selection and request boundaries", () => {
    expect(checkpoint(source)?.command).toContain("pnpm typecheck");
    expect(listProp(source, "LessonOverview", "files")).toContain("tests/context.test.ts");
    for (const marker of [
      'describe("selectContext"',
      'it("优先保留高优先级来源"',
      'it("分离系统规则、用户任务和参考资料"',
    ]) {
      expect(code, `context lesson should keep ${marker}`).toContain(marker);
    }
  });

  it("uses newline escapes that survive copy and paste", () => {
    expect(code).toContain(String.raw`.join("\n")`);
    expect(code).not.toContain(String.raw`.join("\\n")`);
  });
});
