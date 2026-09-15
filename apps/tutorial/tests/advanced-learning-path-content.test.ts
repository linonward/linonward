import { describe, expect, it } from "vitest";

import { checkpoint, codeText, lessonSource, listProp, stepIds } from "./support/lesson-source";

function code(name: string): string {
  return codeText(lessonSource(name));
}

describe("advanced learning path", () => {
  it("teaches persisted clarification and mid-run steering", () => {
    const source = code("user-interaction");

    for (const marker of [
      "UserInputRequest",
      "agent answer <run-id> <request-id>",
      "goal_change",
      "unexpected_user_input",
    ]) {
      expect(source, `user interaction should keep ${marker}`).toContain(marker);
    }
    expect(stepIds(lessonSource("user-interaction"))).toContain("persist-user-request");
  });

  it("teaches traces, task datasets, layered graders, and regression gates", () => {
    const source = code("observability-evaluation");
    const lesson = lessonSource("observability-evaluation");

    expect(source).toContain("TraceEvent");
    expect(source).toContain("RunUsage");
    expect(listProp(lesson, "LessonOverview", "files")).toContain("evals/cases.jsonl");
    expect(checkpoint(lesson)?.command).toContain("tests/eval.test.ts");
  });

  it("finishes with a matrix that includes interaction, attacks, and recovery", () => {
    const source = code("capstone");
    const lesson = lessonSource("capstone");

    expect(listProp(lesson, "LessonOverview", "files")).toContain("evals/capstone.jsonl");
    expect(source).toContain("runCapstoneSuite");
    expect(source).toContain("correctlyBlockedCases");
    expect(stepIds(lesson)).toEqual(
      expect.arrayContaining([
        "define-matrix",
        "run-capstone",
        "inject-failures",
        "review-evidence",
      ]),
    );
  });
});
