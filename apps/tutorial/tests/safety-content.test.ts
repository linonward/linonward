import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

function lesson(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../src/content/${name}.mdx`, import.meta.url)),
    "utf8",
  );
}

describe("safe repository agent lessons", () => {
  it("contains symlinks and option-like search input inside the workspace", () => {
    const source = lesson("understand-repository");

    expect(source).toContain("realpath");
    expect(source).toMatch(/"--",\s+input\.query/);
    expect(source).toContain('"!.git/**"');
    expect(source).toContain('"!dist/**"');
    expect(source).toContain('"!build/**"');
  });

  it("teaches atomic hash-guarded patches instead of whole-file replacement", () => {
    const source = lesson("edit-code");

    expect(source).toContain('name: "apply_patch"');
    expect(source).toContain("expectedSha256");
    expect(source).toContain('flag: "wx"');
    expect(source).toContain("create");
    expect(source).toContain("delete");
    expect(source).not.toContain('name: "write_file"');
  });

  it("binds completion evidence to the current mutation revision and criteria", () => {
    const source = lesson("run-validation");

    expect(source).toContain("mutationRevision");
    expect(source).toContain("validatedRevision");
    expect(source).toContain("changedFileHashes");
    expect(source).toContain("criterionIds");
    expect(source).toContain("requiredValidationCriteria");
  });

  it("supports scoped allow, deny, and human approval decisions", () => {
    const source = lesson("permissions-safety");

    expect(source).toContain('type: "ask"');
    expect(source).toContain("ApprovalRequest");
    expect(source).toContain("authorize(tool, prepared.input, policyContext)");
    expect(source).toContain("tool.prepare(rawInput)");
    expect(source).toContain("network");
    expect(source).toContain("allowedArgv");
  });
});
