import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("../src/content/context-and-prompt.mdx", import.meta.url)),
  "utf8",
);

describe("context and prompt lesson", () => {
  it("provides a runnable verification for context selection and request boundaries", () => {
    expect(source).toContain("tests/context.test.ts");
    expect(source).toContain('describe("selectContext"');
    expect(source).toContain('it("优先保留高优先级来源"');
    expect(source).toContain('it("分离系统规则、用户任务和参考资料"');
    expect(source).toContain('<Checkpoint command="pnpm typecheck && pnpm test">');
  });

  it("uses newline escapes that produce real line breaks when copied", () => {
    expect(source).toContain(String.raw`.join("\n")`);
    expect(source).not.toContain(String.raw`.join("\\n")`);
  });
});
