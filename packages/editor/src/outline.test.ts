import { describe, expect, it } from "vitest";

import { editorSchema } from "./core/schema";
import { getOutlineItems } from "./outline";

describe("getOutlineItems", () => {
  it("returns non-empty H2 through H4 headings in document order", () => {
    const doc = editorSchema.node("doc", null, [
      editorSchema.node("heading", { level: 1 }, editorSchema.text("文章标题")),
      editorSchema.node("heading", { level: 2 }, editorSchema.text("第一章")),
      editorSchema.node("paragraph", null, editorSchema.text("正文")),
      editorSchema.node("heading", { level: 3 }, editorSchema.text("第一节")),
      editorSchema.node("heading", { level: 4 }, editorSchema.text("要点")),
      editorSchema.node("heading", { level: 2 }),
    ]);

    expect(getOutlineItems(doc)).toEqual([
      { level: 2, position: 6, text: "第一章" },
      { level: 3, position: 15, text: "第一节" },
      { level: 4, position: 20, text: "要点" },
    ]);
  });
});
