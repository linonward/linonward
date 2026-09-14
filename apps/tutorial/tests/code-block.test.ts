import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { CodeBlock, formatCode } from "../src/components/code-block";

describe("formatCode", () => {
  it("formats JSON with two-space indentation", () => {
    const source =
      '{"name":"agent-from-scratch","scripts":{"dev":"tsx src/index.ts","typecheck":"tsc --noEmit"}}';

    expect(formatCode(source, "json")).toBe(`{
  "name": "agent-from-scratch",
  "scripts": {
    "dev": "tsx src/index.ts",
    "typecheck": "tsc --noEmit"
  }
}`);
  });

  it("preserves line breaks for non-JSON code", () => {
    expect(formatCode("  const task = true;\n\nconsole.log(task);  ", "typescript")).toBe(
      "const task = true;\n\nconsole.log(task);",
    );
  });

  it("leaves incomplete JSON untouched", () => {
    expect(formatCode('{ "name": "agent"', "json")).toBe('{ "name": "agent"');
  });

  it("renders every code line in a whitespace-preserving element", () => {
    const html = renderToStaticMarkup(
      createElement(
        CodeBlock,
        null,
        `export interface Example {
  value: Array<{
    nested: string;
  }>;
}`,
      ),
    );

    expect(html).toContain('<span class="code-block__line">  value: Array&lt;{</span>');
    expect(html).toContain('<span class="code-block__line">    nested: string;</span>');
  });
});
