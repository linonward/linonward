import type { Mark, Node as PMNode } from "prosemirror-model";
import { describe, expect, it } from "vitest";

import { editorSchema } from "../core/schema";
import { parseMarkdown } from "../markdown/parser";
import { getTheme } from "../themes";

import { renderWechatHtml } from "./renderer";
import { sanitizeWechatHtml } from "./sanitizer";

describe("WeChat renderer", () => {
  it("renders semantic Markdown with inline styles and no classes", () => {
    const html = sanitizeWechatHtml(
      renderWechatHtml(
        parseMarkdown("## 标题\n\n**重点** 与 [链接](https://example.com)"),
        getTheme("default"),
      ),
    );
    expect(html).toContain('<h2 style="');
    expect(html).toContain("<strong>重点</strong>");
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain("class=");
    expect(html).not.toContain("mp-quote");
    expect(html).toContain("font-family:PingFang SC");
  });

  it("does not render unsafe links from a document assembled outside the import pipeline", () => {
    const document = editorSchema.nodes.doc.create(null, [
      editorSchema.nodes.paragraph.create(
        null,
        editorSchema.text("危险", [
          editorSchema.marks.link.create({ href: "javascript:alert(1)" }),
        ]),
      ),
    ]);

    expect(renderWechatHtml(document, getTheme("default"))).not.toContain("javascript:");
  });

  it("groups a lead paragraph and its list into a compact block", () => {
    const html = renderWechatHtml(
      parseMarkdown("这是一个项目：\n\n1. 很好\n2. 一般"),
      getTheme("default"),
    );

    expect(html).toContain('<section data-editor-list-block style="margin:8px 0 18px">');
    expect(html).toContain('<p style="margin:0 0 8px;text-align:left">这是一个项目：</p>');
    expect(html).toContain('<ol style="margin:0;padding-left:26px">');
    expect(html).toContain('<li><p style="margin:0;text-align:left">很好</p></li>');
  });

  it("renders every supported block and inline format", () => {
    const { nodes, marks } = editorSchema;
    const paragraph = (...content: PMNode[]) => nodes.paragraph.create(null, content);
    const text = (content: string, appliedMarks: readonly Mark[] = []) =>
      editorSchema.text(content, appliedMarks);
    const doc = nodes.doc.create(null, [
      nodes.heading.create({ level: 1 }, text("标题")),
      nodes.paragraph.create({ textAlign: "center" }, text("居中文本")),
      paragraph(
        text("格式化", [
          marks.strong.create(),
          marks.em.create(),
          marks.underline.create(),
          marks.strikethrough.create(),
          marks.code.create(),
          marks.link.create({ href: "https://example.com?a=1&b=2" }),
          marks.text_color.create({ color: "#123456" }),
          marks.background_color.create({ color: "#ffff00" }),
          marks.marker.create(),
          marks.font_size.create({ size: "18px" }),
        ]),
        nodes.hard_break.create(),
        text("换行"),
      ),
      nodes.heading.create({ level: 4 }, text("回退标题样式")),
      nodes.blockquote.create(null, paragraph(text("引用"))),
      nodes.bullet_list.create(null, [nodes.list_item.create(null, paragraph(text("无序")))]),
      nodes.ordered_list.create(null, [nodes.list_item.create(null, paragraph(text("有序")))]),
      nodes.table.create(null, [
        nodes.table_row.create(null, [nodes.table_header.create(null, paragraph(text("表头")))]),
        nodes.table_row.create(null, [nodes.table_cell.create(null, paragraph(text("单元格")))]),
      ]),
      nodes.code_block.create(null, text('const value = "<safe>";')),
      nodes.horizontal_rule.create(),
      nodes.image.create({
        alt: "远程图",
        caption: "图 1：远程图片",
        src: "https://example.com/image.png",
      }),
      nodes.image.create({
        alt: "已裁剪图",
        src: "https://example.com/cropped.png",
        cropHeight: 240,
        cropWidth: 320,
        cropX: 25,
        cropY: 75,
        cropSourceWidth: 640,
        cropSourceHeight: 480,
        width: 320,
        filter: "grayscale(1)",
        align: "left",
      }),
      nodes.image.create({ alt: "", src: "data:image/png;base64,abc" }),
      nodes.image.create({ alt: "本地图", src: "./image.png" }),
      nodes.paragraph.create(),
    ]);

    const html = renderWechatHtml(doc, getTheme("minimal"));

    expect(html).toContain("<h1");
    expect(html).toContain("text-align:center");
    expect(html).toContain("<h4");
    expect(html).toContain("<strong>");
    expect(html).toContain("<em>");
    expect(html).toContain("<u style=");
    expect(html).toContain("text-underline-offset:3px");
    expect(html).toContain("text-decoration-color:currentColor");
    expect(html).toContain("<code style=");
    expect(html).toContain("https://example.com?a=1&amp;b=2");
    expect(html).toContain("color:#123456");
    expect(html).toContain("background-color:#ffff00");
    expect(html).toContain("<mark style=");
    expect(html).toContain("background:linear-gradient(transparent 42%,#fff2a8");
    expect(html).toContain("font-size:18px");
    expect(html).toContain("<blockquote");
    expect(html).toContain("<ul");
    expect(html).toContain("<ol");
    expect(html).toContain("<table");
    expect(html).toContain("background:#f1f0ff");
    expect(html).toContain("<th");
    expect(html).toContain("<td");
    expect(html).toContain("&lt;safe&gt;");
    expect(html).toContain('<img src="https://example.com/image.png" alt="远程图"');
    expect(html).toContain("<figure");
    expect(html).toContain("<figcaption");
    expect(html).toContain("text-align:center");
    expect(html).toContain("图 1：远程图片</figcaption>");
    expect(html).toContain("max-width:100%;width:auto");
    expect(html).toContain("overflow:hidden");
    expect(html).toContain("aspect-ratio:320/240");
    expect(html).toContain("width:200%");
    expect(html).toContain("transform:translate(-12.5%,-37.5%)");
    expect(html).toContain("filter:grayscale(1)");
    expect(html).toContain("text-align:left");
    expect(html).toContain('<img src="data:image/png;base64,abc" alt=""');
    expect(html).toContain("无法读取本地图片");
    expect(html).toContain("<br>");
  });
});
