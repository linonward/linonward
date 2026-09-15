import { describe, expect, it } from "vitest";

import { checkpoint, codeText, lessonSource, listProp } from "./support/lesson-source";

function code(name: string): string {
  return codeText(lessonSource(name));
}

describe("safe repository agent lessons", () => {
  it("contains symlinks and option-like search input inside the workspace", () => {
    const source = code("understand-repository");

    expect(source).toContain("realpath");
    expect(source).toMatch(/"--",\s+input\.query/);
    for (const excluded of ['"!.git/**"', '"!dist/**"', '"!build/**"']) {
      expect(source, `search_text should exclude ${excluded}`).toContain(excluded);
    }
  });

  it("teaches atomic hash-guarded patches instead of whole-file replacement", () => {
    const source = code("edit-code");

    expect(source).toContain('name: "apply_patch"');
    expect(source).toContain("expectedSha256");
    expect(source).toContain('flag: "wx"');
    expect(source).toContain('z.literal("create")');
    expect(source).toContain('z.literal("delete")');
    expect(source).not.toContain('name: "write_file"');
  });

  it("binds completion evidence to the current mutation revision and criteria", () => {
    const source = code("run-validation");
    const lesson = lessonSource("run-validation");

    for (const marker of [
      "mutationRevision",
      "validatedRevision",
      "changedFileHashes",
      "criterionIds",
    ]) {
      expect(source, `validation evidence should keep ${marker}`).toContain(marker);
    }
    expect(checkpoint(lesson)?.body).toContain("requiredValidationCriteria");
    expect(listProp(lesson, "LessonOverview", "files")).toContain("src/completion.ts");
  });

  it("supports scoped allow, deny, and human approval decisions", () => {
    const source = code("permissions-safety");

    for (const marker of [
      'type: "ask"',
      "ApprovalRequest",
      "authorize(tool, prepared.input, policyContext)",
      "tool.prepare(rawInput)",
      "network",
      "allowedArgv",
    ]) {
      expect(source, `policy lesson should keep ${marker}`).toContain(marker);
    }
  });
});
