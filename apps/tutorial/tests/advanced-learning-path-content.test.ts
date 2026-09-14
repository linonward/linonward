import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function lesson(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../src/content/${name}.mdx`, import.meta.url)),
    "utf8",
  );
}

describe("advanced learning path", () => {
  it("teaches persisted clarification and mid-run steering", () => {
    const source = lesson("user-interaction");

    expect(source).toContain("UserInputRequest");
    expect(source).toContain("agent answer <run-id> <request-id>");
    expect(source).toContain("goal_change");
    expect(source).toContain("unexpected_user_input");
  });

  it("teaches traces, task datasets, layered graders, and regression gates", () => {
    const source = lesson("observability-evaluation");

    expect(source).toContain("TraceEvent");
    expect(source).toContain("RunUsage");
    expect(source).toContain("evals/cases.jsonl");
    expect(source).toContain("确定性 grader");
    expect(source).toContain("安全回归门禁");
  });

  it("finishes with a matrix that includes interaction, attacks, and recovery", () => {
    const source = lesson("capstone");

    expect(source).toContain("evals/capstone.jsonl");
    expect(source).toContain("请求澄清");
    expect(source).toContain("Prompt injection");
    expect(source).toContain("副作用只发生一次");
    expect(source).toContain("correctlyBlockedCases");
  });
});
