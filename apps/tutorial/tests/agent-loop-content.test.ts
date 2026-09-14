import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("../src/content/agent-loop.mdx", import.meta.url)),
  "utf8",
);

describe("agent loop lesson", () => {
  it("presents the complete decision, action, observation, and stop cycle", () => {
    expect(source).toContain('id="define-invariants"');
    expect(source).toContain('id="implement-complete-loop"');
    expect(source).toContain('id="trace-one-run"');
    expect(source).toContain('id="test-loop"');
    expect(source).toContain("<AgentLoopDiagram />");
    expect(source).toContain('while (state.status === "running")');
    expect(source).toContain('type: "function_call_output"');
    expect(source).toContain('stopReason: "final_answer"');
    expect(source).toContain("maxToolCalls");
    expect(source).toContain("selectNextStep");
    expect(source).toContain("allCriteriaPassed");
    expect(source).toContain('type: "plan_revised"');
    expect(source).toContain("discoverSkills");
    expect(source).toContain("skillCatalogAsContextSource");
    expect(source).toContain("activeSkills");
    expect(source).toContain("continuationContext");
    expect(source).toContain("request.input");
    expect(source).toContain("Harness feedback and current plan are sent on every continuation");
  });
});
