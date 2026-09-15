import { describe, expect, it } from "vitest";

import {
  codeText,
  componentProp,
  hasComponent,
  lessonSource,
  listProp,
  stepIds,
} from "./support/lesson-source";

const source = lessonSource("agent-loop");
const code = codeText(source);

describe("agent loop lesson", () => {
  it("walks decision, action, observation, and stop in runnable TypeScript", () => {
    for (const marker of [
      'while (state.status === "running")',
      'type: "function_call_output"',
      'stopReason: "final_answer"',
      'type: "plan_revised"',
    ]) {
      expect(code, `agent-loop should implement ${marker}`).toContain(marker);
    }
    expect(hasComponent(source, "AgentLoopDiagram")).toBe(true);
  });

  it("re-enters the loop with plan, skills, budget, and continuation context", () => {
    for (const marker of [
      "maxToolCalls",
      "selectNextStep",
      "allCriteriaPassed",
      "discoverSkills",
      "skillCatalogAsContextSource",
      "activeSkills",
      "continuationContext",
      "request.input",
      "Harness feedback and current plan are sent on every continuation",
    ]) {
      expect(code, `agent-loop should carry ${marker}`).toContain(marker);
    }
  });

  it("keeps the anchors that describe the loop contract", () => {
    expect(stepIds(source)).toEqual(
      expect.arrayContaining([
        "define-invariants",
        "define-loop-contract",
        "read-one-iteration",
        "implement-complete-loop",
        "trace-one-run",
        "test-loop",
      ]),
    );
  });

  it("declares the loop entry point and its test file", () => {
    const files = listProp(source, "LessonOverview", "files");

    expect(files).toContain("src/agent-loop.ts");
    expect(files).toContain("tests/agent-loop.test.ts");
    expect(componentProp(source, "LessonOverview", "task")).toBeTruthy();
  });
});
