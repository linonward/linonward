import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("../src/content/task-planning.mdx", import.meta.url)),
  "utf8",
);

describe("task planning lesson", () => {
  it("turns a goal into an observable plan that can be executed and revised", () => {
    expect(source).toContain('id="separate-goal-plan-step"');
    expect(source).toContain('id="define-plan-state"');
    expect(source).toContain('id="create-initial-plan"');
    expect(source).toContain('id="advance-plan"');
    expect(source).toContain('id="replan-from-evidence"');
    expect(source).toContain('id="connect-plan-to-loop"');
    expect(source).toContain('status: "pending" | "in_progress" | "completed" | "blocked"');
    expect(source).toContain("acceptanceCriteria");
    expect(source).toContain("selectNextStep");
    expect(source).toContain("shouldReplan");
    expect(source).toContain("plan_revised");
    expect(source).toContain(`\`\`\`typescript
export interface AcceptanceCriterion {
  id: string;`);
    expect(source).not.toContain("<CodeBlock");
  });
});
