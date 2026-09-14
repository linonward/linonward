import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const lessonPath = fileURLToPath(
  new URL("../src/content/long-running-recovery.mdx", import.meta.url),
);

describe("long-running recovery lesson", () => {
  it("teaches durable checkpoints, event replay, leases, and safe tool recovery", () => {
    const source = readFileSync(lessonPath, "utf8");

    for (const stepId of [
      "separate-runtime-and-durable-state",
      "define-recovery-records",
      "write-atomic-checkpoints",
      "record-tool-intents",
      "restore-and-replay",
      "resume-agent-loop",
      "test-crash-recovery",
    ]) {
      expect(source).toContain(`id="${stepId}"`);
    }

    for (const marker of [
      "RunCheckpoint",
      "schemaVersion",
      "tool_intent",
      "tool_result",
      "idempotencyKey",
      "acquireLease",
      "resumeAgentRun",
      "fsync",
    ]) {
      expect(source).toContain(marker);
    }
  });
});
