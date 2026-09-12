import { describe, expect, it } from "vitest";

import { getTheme, themes } from "./index";

describe("editor themes", () => {
  it("returns selected themes and falls back to the default", () => {
    expect(themes).toHaveLength(4);
    expect(getTheme("default").article.lineHeight).toBe("1.6");
    expect(getTheme("minimal").article.lineHeight).toBe("1.95");
    expect(getTheme("default").editorTokens["--richtext-body"]).toBe("rgba(0, 0, 0, 0.9)");
    expect(getTheme("minimal").editorTokens["--richtext-body"]).toBe("#1e2026");
    expect(getTheme("ocean").editorTokens["--richtext-link"]).toBe("#2376b3");
    expect(getTheme("warm").editorTokens["--richtext-link"]).toBe("#a65a34");
    expect(getTheme("unknown")).toBe(themes[0]);
  });
});
