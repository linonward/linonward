import { describe, expect, it } from "vitest";

import { editorSchema } from "./schema";

describe("editor schema marks", () => {
  it("serializes and parses text and background colors plus font size", () => {
    const color = editorSchema.marks.text_color.create({ color: "#123456" });
    const background = editorSchema.marks.background_color.create({ color: "#fff000" });
    const fontSize = editorSchema.marks.font_size.create({ size: "18px" });
    const underline = editorSchema.marks.underline.create();
    const strikethrough = editorSchema.marks.strikethrough.create();

    expect(editorSchema.marks.text_color.spec.toDOM?.(color, false)).toEqual([
      "span",
      { style: "color:#123456" },
      0,
    ]);
    expect(editorSchema.marks.background_color.spec.toDOM?.(background, false)).toEqual([
      "span",
      { style: "background-color:#fff000" },
      0,
    ]);
    expect(editorSchema.marks.font_size.spec.toDOM?.(fontSize, false)).toEqual([
      "span",
      { style: "font-size:18px" },
      0,
    ]);
    expect(editorSchema.marks.underline.spec.toDOM?.(underline, false)).toEqual([
      "u",
      { style: "text-decoration-thickness:1px;text-underline-offset:3px" },
      0,
    ]);
    expect(editorSchema.marks.strikethrough.spec.toDOM?.(strikethrough, false)).toEqual([
      "s",
      { style: "text-decoration-thickness:1px;text-decoration-color:currentColor" },
      0,
    ]);
    expect(
      editorSchema.marks.marker.spec.toDOM?.(editorSchema.marks.marker.create(), false),
    ).toEqual([
      "mark",
      {
        style:
          "background:linear-gradient(transparent 42%,#fff2a8 42%,#fff2a8 88%,transparent 88%);padding:0 0.08em;border-radius:0.12em;box-decoration-break:clone",
      },
      0,
    ]);
  });

  it("preserves image crop metadata in its DOM representation", () => {
    const uncropped = editorSchema.nodes.image.create({ src: "https://example.com/a.png" });
    const cropped = editorSchema.nodes.image.create({
      src: "https://example.com/a.png",
      alt: "示例图片",
      cropHeight: 240,
      cropX: 35,
      cropY: 65,
      width: 400,
    });

    expect(editorSchema.nodes.image.spec.toDOM?.(uncropped)).toEqual([
      "figure",
      expect.objectContaining({ style: "margin:22px 0;text-align:center" }),
      [
        "img",
        expect.objectContaining({
          style: "display:block;margin:0 auto;max-width:100%;width:auto;height:auto",
        }),
      ],
      ["figcaption", expect.any(Object), ""],
    ]);
    expect(editorSchema.nodes.image.spec.toDOM?.(cropped)).toEqual([
      "figure",
      expect.any(Object),
      [
        "img",
        expect.objectContaining({
          alt: "示例图片",
          style:
            "display:block;margin:0 auto;max-width:100%;width:400px;height:240px;object-fit:cover;object-position:35% 65%",
        }),
      ],
      ["figcaption", expect.any(Object), "示例图片"],
    ]);

    const clipped = editorSchema.nodes.image.create({
      src: "https://example.com/a.png",
      cropWidth: 200,
      cropHeight: 160,
      cropSourceWidth: 400,
      cropSourceHeight: 320,
      cropX: 50,
      cropY: 25,
    });
    expect(editorSchema.nodes.image.spec.toDOM?.(clipped)).toEqual([
      "figure",
      expect.objectContaining({ style: "margin:22px 0;text-align:center" }),
      [
        "span",
        expect.objectContaining({ style: expect.stringContaining("overflow:hidden") }),
        [
          "img",
          expect.objectContaining({
            style: expect.stringContaining("transform:translate(-25%,-12.5%)"),
          }),
        ],
      ],
      ["figcaption", expect.any(Object), ""],
    ]);
    expect(editorSchema.nodes.image.spec.group).toBe("block");
    expect(editorSchema.nodes.image.spec.inline).toBe(false);
  });

  it("renders text alignment on paragraphs and headings", () => {
    const paragraph = editorSchema.nodes.paragraph.create({ textAlign: "center" });
    const heading = editorSchema.nodes.heading.create({ level: 2, textAlign: "right" });
    expect(editorSchema.nodes.paragraph.spec.toDOM?.(paragraph)).toEqual([
      "p",
      { style: "text-align:center" },
      0,
    ]);
    expect(editorSchema.nodes.heading.spec.toDOM?.(heading)).toEqual([
      "h2",
      { style: "text-align:right" },
      0,
    ]);
    const parseRule = editorSchema.nodes.paragraph.spec.parseDOM?.[0];
    expect(parseRule?.getAttrs?.({ style: { textAlign: "" } } as HTMLElement)).toEqual({
      textAlign: "left",
    });
    expect(parseRule?.getAttrs?.({ style: { textAlign: "justify" } } as HTMLElement)).toEqual({
      textAlign: "justify",
    });
  });
});
