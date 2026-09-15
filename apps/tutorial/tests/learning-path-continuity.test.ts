import { describe, expect, it } from "vitest";

import { codeText, lessonSource } from "./support/lesson-source";

/**
 * 跨章接口契约：同一个 `agent-from-scratch` 项目逐章升级，
 * 后面的章节必须继续满足前面章节已经建立的类型与调用顺序。
 *
 * 这里只断言代码块里的签名与顺序，因此正文措辞调整不会误报；
 * 一旦这些断言变红，说明某一章教出来的接口与后续章节不再兼容。
 */
function code(name: string): string {
  return codeText(lessonSource(name));
}

describe("cumulative tutorial project", () => {
  it("keeps the offline model path runnable after ModelRequest replaces strings", () => {
    expect(code("model-call")).toContain("export function createModel");
    expect(code("context-and-prompt")).toContain(
      "async generate(_request: ModelRequest): Promise<string>",
    );
  });

  it("introduces every write capability before the patch tool uses it", () => {
    const source = code("edit-code");

    expect(source).toContain("export interface WriteLease");
    expect(source).toContain("writeLease: WriteLease");
    expect(source).toContain("defineTool({");
  });

  it("keeps schema validation before policy and policy before side effects", () => {
    const source = code("permissions-safety");

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
    const source = code("task-state");

    expect(source).toContain("validations: ValidationRecord[]");
    expect(source).toContain("requiredCriterionIds: string[]");
    expect(source).toContain("mutationRevision: number");
    expect(source).toContain('"waiting"');
    expect(source).toContain('"cancelled"');
  });

  it("adds interaction and skill fields before the full loop reads them", () => {
    expect(code("user-interaction")).toContain("pendingUserInput?: UserInputRequest");
    expect(code("progressive-skills")).toContain("skills: SkillState");
    expect(code("progressive-skills")).toContain("skill_instructions: true");
    expect(code("progressive-skills")).toContain("skill_resource: true");
  });

  it("connects trace collection and evaluation to executable entry points", () => {
    const source = code("observability-evaluation");

    expect(source).toContain("export interface TraceSink");
    expect(source).toContain("export async function runEvaluation");
  });

  it("preserves authoritative state through compaction and recovery", () => {
    const compaction = code("context-compaction");
    const recovery = code("long-running-recovery");

    expect(compaction).not.toContain("state.pendingToolCalls");
    expect(compaction).toContain("validation evidence changed during compaction");
    expect(recovery).toContain("changedFileHashes: Record<string, string>");
    expect(recovery).toContain("validations: ValidationRecord[]");
    expect(recovery).toContain("budget: AgentBudget");
    expect(recovery).toContain("pendingUserInput?: UserInputRequest | undefined");
  });

  it("gives the capstone a concrete suite runner instead of only a checklist", () => {
    expect(code("capstone")).toContain("export async function runCapstoneSuite");
  });
});
