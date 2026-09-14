import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const lessonPath = fileURLToPath(new URL("../src/content/context-compaction.mdx", import.meta.url));

describe("context compaction lesson", () => {
  it("teaches a loss-aware compaction path and connects it to the loop", () => {
    const source = readFileSync(lessonPath, "utf8");

    for (const stepId of [
      "define-compaction-contract",
      "choose-compaction-boundary",
      "build-compaction-snapshot",
      "validate-compaction",
      "replace-history-with-snapshot",
      "connect-compaction-to-loop",
      "test-compaction",
    ]) {
      expect(source).toContain(`id="${stepId}"`);
    }

    for (const marker of [
      "CompactionSnapshot",
      "maybeCompactContext",
      "compaction_started",
      "compaction_completed",
      "rawTail",
      "sourceEventRange",
      "responses.compact",
    ]) {
      expect(source).toContain(marker);
    }
  });
});
