import { describe, expect, it } from "vitest";

import { safeLinkHref, sanitizeEditorDocument } from "./contentSafety";
import { editorSchema } from "./core/schema";

describe("editor content safety", () => {
  it("accepts only explicitly supported link protocols", () => {
    expect(safeLinkHref("https://example.com/article")).toBe("https://example.com/article");
    expect(safeLinkHref("mailto:hi@example.com")).toBe("mailto:hi@example.com");
    expect(safeLinkHref("#chapter-1")).toBe("#chapter-1");
    expect(safeLinkHref("javascript:alert(1)")).toBeNull();
    expect(safeLinkHref("data:text/html,unsafe")).toBeNull();
  });

  it("removes unsafe marks and normalizes externally supplied node attributes", () => {
    const document = editorSchema.nodes.doc.create(null, [
      editorSchema.nodes.paragraph.create(
        { textAlign: "center;position:fixed" },
        editorSchema.text("危险链接", [
          editorSchema.marks.link.create({ href: "javascript:alert(1)" }),
          editorSchema.marks.text_color.create({ color: "red;position:fixed" }),
        ]),
      ),
      editorSchema.nodes.image.create({
        src: "https://example.com/image.png",
        align: "left;position:fixed",
        width: "999999px",
      }),
    ]);

    const sanitized = sanitizeEditorDocument(document);
    expect(sanitized.firstChild?.attrs.textAlign).toBe("left");
    expect(sanitized.firstChild?.firstChild?.marks).toHaveLength(0);
    expect(sanitized.lastChild?.attrs).toMatchObject({ align: "center", width: null });
  });
});
