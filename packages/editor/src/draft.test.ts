import { describe, expect, it } from "vitest";

import { editorSchema } from "./core/schema";
import { loadDraft, serializeDraft } from "./draft";

describe("editor draft", () => {
  it("serializes a versioned, valid draft", () => {
    const raw = serializeDraft({
      title: "文章",
      themeId: "minimal",
      document: editorSchema.node("doc", null, [editorSchema.node("paragraph")]),
    });

    expect(loadDraft(raw)?.themeId).toBe("minimal");
    expect(loadDraft(raw)?.title).toBe("文章");
  });

  it("rejects invalid, outdated, and unsupported drafts", () => {
    expect(loadDraft("not json")).toBeNull();
    expect(loadDraft(JSON.stringify({ version: 3, title: "文章", themeId: "default" }))).toBeNull();
    expect(loadDraft(JSON.stringify({ version: 1, title: "文章", themeId: "missing" }))).toBeNull();
  });

  it("migrates the legacy unversioned local draft", () => {
    const legacy = JSON.stringify({
      title: "旧草稿",
      themeId: "default",
      document: editorSchema.node("doc", null, [editorSchema.node("paragraph")]).toJSON(),
    });

    expect(loadDraft(legacy)?.title).toBe("旧草稿");
  });

  it("migrates images from legacy paragraphs into block nodes", () => {
    const legacy = JSON.stringify({
      version: 1,
      title: "旧图片草稿",
      themeId: "default",
      document: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "图片前" },
              {
                type: "image",
                attrs: { src: "https://example.com/image.png", alt: null, title: null },
              },
              { type: "text", text: "图片后" },
            ],
          },
        ],
      },
    });

    expect(loadDraft(legacy)?.document.toJSON().content).toEqual([
      expect.objectContaining({
        type: "paragraph",
        content: [{ type: "text", text: "图片前" }],
      }),
      expect.objectContaining({ type: "image" }),
      expect.objectContaining({
        type: "paragraph",
        content: [{ type: "text", text: "图片后" }],
      }),
    ]);
  });
});
