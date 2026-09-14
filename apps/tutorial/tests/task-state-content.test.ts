import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("../src/content/task-state.mdx", import.meta.url)),
  "utf8",
);

describe("task state lesson", () => {
  it("teaches an auditable lifecycle state machine", () => {
    expect(source).toContain("allowedTransitions");
    expect(source).toContain("transitionState");
    expect(source).toContain("nextEventSequence");
    expect(source).toContain("recordedAt");
    expect(source).toContain('running: ["waiting", "completed", "failed", "blocked", "cancelled"]');
    expect(source).toContain('waiting: ["running", "failed", "cancelled"]');
    expect(source).toContain("blocked: []");
    expect(source).toContain("invalid state transition");
    expect(source).toContain("tests/state.test.ts");
  });
});
