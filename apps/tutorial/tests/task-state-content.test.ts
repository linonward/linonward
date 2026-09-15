import { describe, expect, it } from "vitest";

import { checkpoint, codeText, lessonSource, listProp } from "./support/lesson-source";

const source = lessonSource("task-state");
const code = codeText(source);

describe("task state lesson", () => {
  it("teaches an auditable lifecycle state machine in code", () => {
    for (const marker of [
      "allowedTransitions",
      "transitionState",
      "nextEventSequence",
      "recordedAt",
      'running: ["waiting", "completed", "failed", "blocked", "cancelled"]',
      'waiting: ["running", "failed", "cancelled"]',
      "blocked: []",
      "invalid state transition",
    ]) {
      expect(code, `task state lesson should keep ${marker}`).toContain(marker);
    }
  });

  it("points its checkpoint at the state test file", () => {
    expect(checkpoint(source)?.command).toContain("tests/state.test.ts");
    expect(listProp(source, "LessonOverview", "files")).toContain("src/state.ts");
  });

  it("does not defer validation evidence to a later chapter", () => {
    expect(source).not.toContain("最终完成还要在验证章加入");
  });
});
