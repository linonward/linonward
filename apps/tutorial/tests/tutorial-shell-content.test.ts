import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("../src/components/tutorial-shell.tsx", import.meta.url)),
  "utf8",
);

describe("tutorial shell", () => {
  it("labels chapter position accurately and exposes mobile navigation state", () => {
    expect(source).toContain("章节位置");
    expect(source).not.toContain("阅读进度");
    expect(source).toContain("MobileNavigation");
    expect(source).toContain("mobile-toc");
    expect(source).toContain("chapter.minutes");
    expect(source).toContain('chapter.slug === "start"');
  });
});
