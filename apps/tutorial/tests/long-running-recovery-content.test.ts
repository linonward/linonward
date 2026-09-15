import { describe, expect, it } from "vitest";

import { codeText, lessonSource, listProp, stepIds } from "./support/lesson-source";

const source = lessonSource("long-running-recovery");
const code = codeText(source);

describe("long-running recovery lesson", () => {
  it("keeps the anchors of durable checkpoints, replay, leases, and safe recovery", () => {
    expect(stepIds(source)).toEqual([
      "separate-runtime-and-durable-state",
      "define-recovery-records",
      "write-atomic-checkpoints",
      "record-tool-intents",
      "restore-and-replay",
      "resume-agent-loop",
      "test-crash-recovery",
    ]);
  });

  it("keeps the durable record, fencing, and idempotency contract in code", () => {
    for (const marker of [
      "RunCheckpoint",
      "schemaVersion",
      "tool_intent",
      "tool_result",
      "idempotencyKey",
      "acquireLease",
      "resumeAgentRun",
      "fsync",
      "loadCheckpointHistory",
      "lease.epoch",
      "eventsThroughCheckpoint",
    ]) {
      expect(code, `recovery lesson should keep ${marker}`).toContain(marker);
    }
  });

  it("declares the run store, checkpoint, and recovery modules", () => {
    const files = listProp(source, "LessonOverview", "files");

    expect(files).toContain("src/run-store.ts");
    expect(files).toContain("src/checkpoint.ts");
    expect(files).toContain("src/recovery.ts");
    expect(files).toContain("tests/recovery.test.ts");
  });
});
