import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function lesson(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../src/content/${name}.mdx`, import.meta.url)),
    "utf8",
  );
}

describe("cumulative tutorial project", () => {
  it("keeps the offline model path runnable after ModelRequest replaces strings", () => {
    expect(lesson("model-call")).toContain("export function createModel");
    expect(lesson("context-and-prompt")).toContain(
      "async generate(_request: ModelRequest): Promise<string>",
    );
  });

  it("introduces every write capability before the patch tool uses it", () => {
    const source = lesson("edit-code");

    expect(source).toContain("export interface WriteLease");
    expect(source).toContain("writeLease: WriteLease");
    expect(source).toContain("defineTool({");
  });

  it("keeps schema validation before policy and side effects", () => {
    const source = lesson("permissions-safety");

    expect(source).toContain("prepare(input: unknown): PreparedToolCall");
    expect(source).toContain("const prepared = tool.prepare(rawInput)");
    expect(source.indexOf("tool.prepare(rawInput)")).toBeLessThan(
      source.indexOf("authorize(tool, prepared.input, policyContext)"),
    );
    expect(source.indexOf("authorize(tool, prepared.input, policyContext)")).toBeLessThan(
      source.indexOf("prepared.execute(toolContext)"),
    );
  });

  it("upgrades minimal state without dropping validation evidence or lifecycle states", () => {
    const source = lesson("task-state");

    expect(source).toContain("validations: ValidationRecord[]");
    expect(source).toContain("requiredCriterionIds: string[]");
    expect(source).toContain("mutationRevision: number");
    expect(source).toContain('"waiting"');
    expect(source).toContain('"cancelled"');
    expect(source).not.toContain("最终完成还要在验证章加入");
  });

  it("adds interaction and skill fields before the full loop reads them", () => {
    expect(lesson("user-interaction")).toContain("pendingUserInput?: UserInputRequest");
    expect(lesson("progressive-skills")).toContain("skills: SkillState");
    expect(lesson("progressive-skills")).toContain("skill_instructions: true");
    expect(lesson("progressive-skills")).toContain("skill_resource: true");
  });

  it("connects trace collection and evaluation to executable entry points", () => {
    const source = lesson("observability-evaluation");

    expect(source).toContain("export interface TraceSink");
    expect(source).toContain("export async function runEvaluation");
    expect(source).toContain("tests/eval.test.ts");
  });

  it("preserves authoritative state through compaction and recovery", () => {
    const compaction = lesson("context-compaction");
    const recovery = lesson("long-running-recovery");

    expect(compaction).not.toContain("state.pendingToolCalls");
    expect(compaction).toContain("validation evidence changed during compaction");
    expect(recovery).toContain("changedFileHashes: Record<string, string>");
    expect(recovery).toContain("validations: ValidationRecord[]");
    expect(recovery).toContain("budget: AgentBudget");
    expect(recovery).toContain("pendingUserInput?: UserInputRequest | undefined");
  });

  it("gives the capstone a concrete suite runner instead of only a checklist", () => {
    const source = lesson("capstone");

    expect(source).toContain("export async function runCapstoneSuite");
    expect(source).toContain("tests/capstone.test.ts");
  });
});
