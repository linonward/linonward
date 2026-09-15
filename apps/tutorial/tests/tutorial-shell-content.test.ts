import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("../src/components/tutorial-shell.tsx", import.meta.url)),
  "utf8",
);

/**
 * 阅读壳层的接线契约。壳层是服务端组件，这里用源码级断言固定它的可访问性标签与双轨导航，
 * 避免为了渲染它而引入额外的测试依赖。
 */
describe("tutorial shell", () => {
  it("labels chapter position accurately and exposes mobile navigation state", () => {
    expect(source).toContain("章节位置");
    expect(source).not.toContain("阅读进度");
    expect(source).toContain("MobileNavigation");
    expect(source).toContain("mobile-toc");
    expect(source).toContain("chapter.minutes");
    expect(source).toContain('chapter.slug === "start"');
  });

  it("renders both tracks and links the extension index", () => {
    expect(source).toContain("extensionChapters");
    expect(source).toContain("getExtensionNeighbors");
    expect(source).toContain("扩展篇位置");
    expect(source).toContain('href="/extensions"');
    expect((source.match(/<ChapterLinks/g) ?? []).length).toBe(2);
  });
});
