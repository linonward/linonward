import type { Mark, MarkType, NodeType } from "prosemirror-model";
import { Schema } from "prosemirror-model";
import { schema as basicSchema } from "prosemirror-schema-basic";
import { addListNodes } from "prosemirror-schema-list";
import { tableNodes } from "prosemirror-tables";

import { safeLinkHref } from "../contentSafety";
import {
  imageCaption,
  imageCaptionStyle,
  imageFigureStyle,
  imagePresentation,
} from "../imagePresentation";
import type { ImageAttributes } from "../imageTypes";

const imageNode = {
  ...basicSchema.spec.nodes.get("image"),
  inline: false,
  group: "block",
  attrs: {
    src: {},
    alt: { default: null },
    title: { default: null },
    caption: { default: null },
    width: { default: null },
    cropHeight: { default: null },
    cropWidth: { default: null },
    cropX: { default: 50 },
    cropY: { default: 50 },
    cropSourceWidth: { default: null },
    cropSourceHeight: { default: null },
    filter: { default: "none" },
    align: { default: "center" },
  },
  toDOM: (node: { attrs: ImageAttributes }) => {
    const { src, alt, title } = node.attrs;
    const caption = imageCaption(node.attrs);
    const presentation = imagePresentation(node.attrs, { margin: "0", includeAutoWidth: true });
    const image = ["img", { src, alt, title, style: presentation.imageStyle }] as const;
    const content = presentation.frameStyle
      ? (["span", { style: presentation.frameStyle }, image] as const)
      : image;
    return [
      "figure",
      { style: imageFigureStyle(node.attrs.align) },
      content,
      ["figcaption", { style: imageCaptionStyle }, caption],
    ] as const;
  },
};
const linkMark = {
  ...basicSchema.spec.marks.get("link")!,
  parseDOM: [
    {
      tag: "a[href]",
      getAttrs: (dom: HTMLElement) => {
        const href = safeLinkHref(dom.getAttribute("href"));
        return href ? { href, title: dom.getAttribute("title") } : false;
      },
    },
  ],
};
const textBlock = (name: "paragraph" | "heading") => {
  const spec = basicSchema.spec.nodes.get(name)!;
  const getTextAlign = (dom: HTMLElement) => ({ textAlign: dom.style.textAlign || "left" });
  return {
    ...spec,
    attrs: { ...spec.attrs, textAlign: { default: "left" } },
    parseDOM:
      name === "paragraph"
        ? [{ tag: "p", getAttrs: getTextAlign }]
        : [1, 2, 3, 4, 5, 6].map((level) => ({
            tag: `h${level}`,
            getAttrs: (dom: HTMLElement) => ({ ...getTextAlign(dom), level }),
          })),
    toDOM: (node: { attrs: Record<string, string | number | null> }) =>
      [
        name === "paragraph" ? "p" : `h${node.attrs.level}`,
        { style: `text-align:${node.attrs.textAlign || "left"}` },
        0,
      ] as const,
  };
};
const colorMark = (property: "color" | "background-color") => ({
  attrs: { color: {} },
  parseDOM: [{ style: `${property}=`, getAttrs: (value: string) => ({ color: value }) }],
  toDOM: (mark: Mark) => ["span", { style: `${property}:${mark.attrs.color}` }, 0] as const,
});
const fontSizeMark = {
  attrs: { size: {} },
  parseDOM: [{ style: "font-size=", getAttrs: (value: string) => ({ size: value }) }],
  toDOM: (mark: Mark) => ["span", { style: `font-size:${mark.attrs.size}` }, 0] as const,
};
const markerMark = {
  parseDOM: [{ tag: "mark" }],
  toDOM: () =>
    [
      "mark",
      {
        style:
          "background:linear-gradient(transparent 42%,#fff2a8 42%,#fff2a8 88%,transparent 88%);padding:0 0.08em;border-radius:0.12em;box-decoration-break:clone",
      },
      0,
    ] as const,
};
const underlineMark = {
  parseDOM: [
    { tag: "u" },
    { style: "text-decoration", getAttrs: (value: string) => value.includes("underline") && null },
  ],
  toDOM: () =>
    ["u", { style: "text-decoration-thickness:1px;text-underline-offset:3px" }, 0] as const,
};
const strikethroughMark = {
  parseDOM: [
    { tag: "s" },
    { tag: "del" },
    { tag: "strike" },
    {
      style: "text-decoration",
      getAttrs: (value: string) => value.includes("line-through") && null,
    },
  ],
  toDOM: () =>
    [
      "s",
      { style: "text-decoration-thickness:1px;text-decoration-color:currentColor" },
      0,
    ] as const,
};
type EditorNodeName =
  | "blockquote"
  | "bullet_list"
  | "code_block"
  | "doc"
  | "hard_break"
  | "heading"
  | "horizontal_rule"
  | "image"
  | "list_item"
  | "ordered_list"
  | "paragraph"
  | "table"
  | "table_cell"
  | "table_header"
  | "table_row"
  | "text";
type EditorMarkName =
  | "background_color"
  | "code"
  | "em"
  | "font_size"
  | "link"
  | "marker"
  | "strikethrough"
  | "strong"
  | "text_color"
  | "underline";
export type EditorSchema = Omit<Schema, "marks" | "nodes"> & {
  nodes: Record<EditorNodeName, NodeType>;
  marks: Record<EditorMarkName, MarkType>;
};

export const editorSchema = new Schema({
  nodes: addListNodes(
    basicSchema.spec.nodes
      .update("image", imageNode)
      .update("paragraph", textBlock("paragraph"))
      .update("heading", textBlock("heading"))
      .append(tableNodes({ tableGroup: "block", cellContent: "block+", cellAttributes: {} })),
    "paragraph block*",
    "block",
  ),
  marks: basicSchema.spec.marks
    .remove("link")
    .addToEnd("link", linkMark)
    .addToEnd("text_color", colorMark("color"))
    .addToEnd("background_color", colorMark("background-color"))
    .addToEnd("marker", markerMark)
    .addToEnd("font_size", fontSizeMark)
    .addToEnd("underline", underlineMark)
    .addToEnd("strikethrough", strikethroughMark),
}) as unknown as EditorSchema;
