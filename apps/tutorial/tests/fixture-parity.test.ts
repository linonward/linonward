import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * 教程教出来的接口，必须在可执行 fixture 里真的存在。
 *
 * `fixture-coverage.test.ts` 保证"Checkpoint 点名的测试文件存在"，
 * 这个文件保证"正文教的那些函数/类型确实被实现了"，避免 fixture 退化成
 * 只有文件名对得上的空壳。
 */
const fixtureDirectory = fileURLToPath(
  new URL("../../../packages/agent-from-scratch-fixture", import.meta.url),
);

const expectedExports: Array<{ file: string; symbols: string[] }> = [
  { file: "src/context.ts", symbols: ["selectContext", "buildModelRequest", "summarizeSources"] },
  { file: "src/system-prompt.ts", symbols: ["buildSystemPrompt"] },
  { file: "src/model.ts", symbols: ["toModelTurn", "ModelDriver", "createOpenAIModelDriver"] },
  { file: "src/model-factory.ts", symbols: ["createModel"] },
  { file: "src/state.ts", symbols: ["createInitialState", "appendEvent", "transitionState"] },
  { file: "src/tool.ts", symbols: ["defineTool", "WriteLease", "ToolEffect"] },
  { file: "src/tool-registry.ts", symbols: ["ToolRegistry"] },
  { file: "src/workspace.ts", symbols: ["assertInside", "resolveExistingWorkspacePath"] },
  { file: "src/policy.ts", symbols: ["authorize", "ApprovalRequest", "actionDigestFor"] },
  { file: "src/execute-tool.ts", symbols: ["executeToolCall"] },
  { file: "src/completion.ts", symbols: ["checkCompletion"] },
  {
    file: "src/plan.ts",
    symbols: ["selectNextStep", "reconcilePlan", "allCriteriaPassed", "shouldReplan"],
  },
  { file: "src/planner.ts", symbols: ["validatePlan", "createInitialPlan"] },
  { file: "src/interaction.ts", symbols: ["waitForUserInput", "applyUserAnswer"] },
  { file: "src/skill-catalog.ts", symbols: ["discoverSkills"] },
  { file: "src/skill-runtime.ts", symbols: ["activateSkill", "loadSkillResource"] },
  { file: "src/trace.ts", symbols: ["TraceSink", "InMemoryTraceSink"] },
  { file: "src/eval.ts", symbols: ["runEvaluation"] },
  { file: "src/agent-loop.ts", symbols: ["runAgentLoop"] },
  {
    file: "src/compaction.ts",
    symbols: ["validateCompaction", "maybeCompactContext", "projectCompactedContext"],
  },
  { file: "src/run-store.ts", symbols: ["RunStore", "RunLease"] },
  { file: "src/recovery.ts", symbols: ["restoreRun", "resumeAgentRun"] },
  { file: "src/capstone.ts", symbols: ["runCapstoneSuite", "assertCapstonePassed"] },
];

describe("executable fixture parity", () => {
  it.each(expectedExports)(
    "$file implements the interfaces the tutorial teaches",
    ({ file, symbols }) => {
      const path = `${fixtureDirectory}/${file}`;
      expect(existsSync(path), `${file} is missing from the fixture`).toBe(true);

      const source = readFileSync(path, "utf8");
      for (const symbol of symbols) {
        expect(
          new RegExp(`export\\s[^\\n]*\\b${symbol}\\b`).test(source),
          `${file} should export ${symbol}`,
        ).toBe(true);
      }
    },
  );

  it("exposes the run, resume, and answer entry points the tutorial builds", () => {
    const source = readFileSync(`${fixtureDirectory}/src/index.ts`, "utf8");

    for (const command of ['"run"', '"resume"', '"answer"']) {
      expect(source, `src/index.ts should handle ${command}`).toContain(command);
    }
  });

  it("ships the sample skill and evaluation fixtures the chapters reference", () => {
    for (const path of [
      "skills/repository-audit/SKILL.md",
      "skills/repository-audit/references/checklist.md",
      "evals/cases.jsonl",
      "evals/capstone.jsonl",
    ]) {
      expect(existsSync(`${fixtureDirectory}/${path}`), `${path} is missing`).toBe(true);
    }
  });
});
