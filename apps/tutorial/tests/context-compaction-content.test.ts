import { describe, expect, it } from "vitest";

import { codeText, lessonSource, listProp, stepIds } from "./support/lesson-source";

const source = lessonSource("context-compaction");
const code = codeText(source);

describe("context compaction lesson", () => {
  it("keeps the anchors of a loss-aware compaction path", () => {
    expect(stepIds(source)).toEqual([
      "define-compaction-contract",
      "choose-compaction-boundary",
      "build-compaction-snapshot",
      "validate-compaction",
      "replace-history-with-snapshot",
      "connect-compaction-to-loop",
      "test-compaction",
    ]);
  });

  it("keeps the snapshot, boundary, and provider-compaction contract in code", () => {
    for (const marker of [
      "CompactionSnapshot",
      "maybeCompactContext",
      "compaction_started",
      "compaction_completed",
      "rawTail",
      "sourceEventRange",
      "responses.compact",
      "snapshot.goal !== state.task",
      "assertCriteriaEqual",
      "assertCompletedWorkEqual",
      "selectRawTailBoundary",
    ]) {
      expect(code, `compaction lesson should keep ${marker}`).toContain(marker);
    }
  });

  it("declares the compaction module and its test file", () => {
    const files = listProp(source, "LessonOverview", "files");

    expect(files).toContain("src/compaction.ts");
    expect(files).toContain("tests/compaction.test.ts");
  });
});
