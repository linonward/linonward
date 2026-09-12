import { describe, expect, it } from "vitest";

import { editorSchema } from "../core/schema";

import { parseMarkdown, serializeMarkdown } from "./parser";

describe("Markdown conversion", () => {
  it("parses and serializes core article structure", () => {
    const source = "# 标题\n\n正文内容\n\n> 引用\n\n- 第一项\n- 第二项";

    const document = parseMarkdown(source);
    const markdown = serializeMarkdown(document);

    expect(document.firstChild?.type.name).toBe("heading");
    expect(document.textContent).toContain("正文内容");
    expect(markdown).toContain("# 标题");
    expect(markdown).toContain("> 引用");
    expect(markdown).toContain("* 第一项");
  });

  it("drops unsafe links when importing Markdown", () => {
    const document = parseMarkdown("[不安全](javascript:alert(1)) 和 [安全](https://example.com)");
    const textNodes = document.firstChild?.content.content || [];

    expect(textNodes[0].marks).toHaveLength(0);
    expect(textNodes.at(-1)?.marks[0]?.attrs.href).toBe("https://example.com");
  });

  it("exports underline and strikethrough formatting", () => {
    const paragraph = editorSchema.nodes.paragraph.create(null, [
      editorSchema.text("下划线", [editorSchema.marks.underline.create()]),
      editorSchema.text("删除线", [editorSchema.marks.strikethrough.create()]),
    ]);

    expect(serializeMarkdown(editorSchema.nodes.doc.create(null, [paragraph]))).toContain(
      "<u>下划线</u>~~删除线~~",
    );
  });

  it("round-trips editor-only inline formatting through its Markdown extension", () => {
    const paragraph = editorSchema.nodes.paragraph.create(null, [
      editorSchema.text("颜色", [editorSchema.marks.text_color.create({ color: "#4438e8" })]),
      editorSchema.text("背景", [editorSchema.marks.background_color.create({ color: "#fff2a8" })]),
      editorSchema.text("标记", [editorSchema.marks.marker.create()]),
      editorSchema.text("字号", [editorSchema.marks.font_size.create({ size: "20px" })]),
    ]);
    const source = editorSchema.nodes.doc.create(null, [paragraph]);
    const restored = parseMarkdown(serializeMarkdown(source));
    const marks = restored.firstChild?.content.content.map((node) => node.marks[0]?.type.name);

    expect(marks).toEqual(["text_color", "background_color", "marker", "font_size"]);
    expect(restored.firstChild?.child(0).marks[0].attrs.color).toBe("#4438e8");
    expect(restored.firstChild?.child(3).marks[0].attrs.size).toBe("20px");
  });

  it("round-trips image presentation metadata through a standard Markdown image", () => {
    const image = editorSchema.nodes.image.create({
      src: "https://example.com/image.png",
      alt: "产品图",
      caption: "图 1：产品图",
      align: "left",
      filter: "grayscale(1)",
      cropWidth: 320,
      cropHeight: 240,
      cropX: 25,
      cropY: 75,
      cropSourceWidth: 640,
      cropSourceHeight: 480,
    });
    const source = editorSchema.nodes.doc.create(null, [image]);
    const markdown = serializeMarkdown(source);
    const restored = parseMarkdown(markdown).firstChild;

    expect(markdown).toContain("![产品图](https://example.com/image.png)");
    expect(markdown).toContain("<!--linonward-image:");
    expect(restored?.attrs).toMatchObject({
      caption: "图 1：产品图",
      align: "left",
      filter: "grayscale(1)",
      cropWidth: 320,
      cropHeight: 240,
      cropX: 25,
      cropY: 75,
      cropSourceWidth: 640,
      cropSourceHeight: 480,
    });
  });

  it("imports underline HTML tags emitted by Markdown exports", () => {
    const document = parseMarkdown("<u>Agent 越来越多，工具越多</u>，需要统一管理。");
    const underlinedText = document.firstChild?.firstChild;

    expect(document.textContent).toBe("Agent 越来越多，工具越多，需要统一管理。");
    expect(underlinedText?.marks.map((mark) => mark.type.name)).toContain("underline");
    expect(serializeMarkdown(document)).toContain("<u>Agent 越来越多，工具越多</u>");
  });

  it("imports strikethrough Markdown emitted by Markdown exports", () => {
    const document = parseMarkdown(
      "最后，~~这些问题又回到了同一个创业者面前，我成了上下文的搬运工~~。",
    );
    const strikethroughText = document.firstChild?.content.content.find((node) =>
      node.marks.some((mark) => mark.type.name === "strikethrough"),
    );

    expect(document.textContent).toBe(
      "最后，这些问题又回到了同一个创业者面前，我成了上下文的搬运工。",
    );
    expect(strikethroughText?.marks.map((mark) => mark.type.name)).toContain("strikethrough");
    expect(serializeMarkdown(document)).toContain(
      "~~这些问题又回到了同一个创业者面前，我成了上下文的搬运工~~",
    );
  });

  it("imports bold Markdown with whitespace before its closing delimiter", () => {
    const document = parseMarkdown(
      "问题是： **Agent 能替人做多少真实和连续的\n工作？　**记住这个词。",
    );
    const boldText = document.firstChild?.content.content.find((node) =>
      node.marks.some((mark) => mark.type.name === "strong"),
    );

    expect(document.textContent).toBe(
      "问题是： Agent 能替人做多少真实和连续的 工作？　记住这个词。",
    );
    expect(boldText?.text).toBe("Agent 能替人做多少真实和连续的 工作？");
    expect(serializeMarkdown(document)).toContain(
      "**Agent 能替人做多少真实和连续的 工作？**　记住这个词。",
    );
  });

  it("repairs loose bold delimiters and headings from imported Markdown", () => {
    const document = parseMarkdown(
      "问题是： **Agent 能替人做多少真实和连续的\n工作？ **记住这个词。\n\n#####** 1、任务做完了，生意才刚开始，因为业务是连续的**",
    );
    const paragraphStrongText = document.firstChild?.content.content.find((node) =>
      node.marks.some((mark) => mark.type.name === "strong"),
    );
    const heading = document.child(1);

    expect(paragraphStrongText?.text).toBe("Agent 能替人做多少真实和连续的 工作？");
    expect(heading.type.name).toBe("heading");
    expect(heading.textContent).toBe("1、任务做完了，生意才刚开始，因为业务是连续的");
    expect(heading.firstChild?.marks.map((mark) => mark.type.name)).toContain("strong");
  });

  it("repairs non-breaking and zero-width spaces inside loose bold delimiters", () => {
    const document = parseMarkdown("**\u200bAgent 能替人做事\u00a0**继续处理。");
    const strongText = document.firstChild?.content.content.find((node) =>
      node.marks.some((mark) => mark.type.name === "strong"),
    );

    expect(strongText?.text).toBe("Agent 能替人做事");
    expect(document.textContent).toBe("Agent 能替人做事 继续处理。");
  });

  it("imports the reported Agent sentence with a non-breaking space", () => {
    const document = parseMarkdown(
      "产品很有想法，甚至我认为是具备前瞻性的。而且，我近期最关心的一个问题是：**Agent 能替人做多少真实和连续的工作？** 记住这个词，“连续”，真的很重要。&#x20;",
    );
    const strongText = document.firstChild?.content.content.find((node) =>
      node.marks.some((mark) => mark.type.name === "strong"),
    );

    expect(strongText?.text).toBe("Agent 能替人做多少真实和连续的工作？");
    expect(document.textContent).toContain("记住这个词，“连续”，真的很重要。");
  });

  it("keeps the reported Agent sentence bold when followed by a bold heading", () => {
    const document = parseMarkdown(
      "产品很有想法，甚至我认为是具备前瞻性的。而且，我近期最关心的一个问题是：**Agent 能替人做多少真实和连续的工作？**记住这个词，“连续”，真的很重要。\n\n#### **1、任务做完了，生意才刚开始，因为业务是连续的**",
    );
    const strongTexts: string[] = [];
    document.descendants((node) => {
      if (node.isText && node.marks.some((mark) => mark.type.name === "strong")) {
        strongTexts.push(node.text || "");
      }
    });

    expect(strongTexts).toContain("Agent 能替人做多少真实和连续的工作？");
    expect(strongTexts).toContain("1、任务做完了，生意才刚开始，因为业务是连续的");
  });

  it("does not alter a fenced code block containing bold delimiters", () => {
    const document = parseMarkdown("```md\n** 代码示例 **\n```");

    expect(document.firstChild?.type.name).toBe("code_block");
    expect(document.textContent).toBe("** 代码示例 **");
  });

  it("exports editor tables as pipe tables", () => {
    const paragraph = (text: string) =>
      editorSchema.nodes.paragraph.create(null, editorSchema.text(text));
    const table = editorSchema.nodes.table.create(null, [
      editorSchema.nodes.table_row.create(null, [
        editorSchema.nodes.table_header.create(null, paragraph("名称")),
        editorSchema.nodes.table_header.create(null, paragraph("描述")),
      ]),
      editorSchema.nodes.table_row.create(null, [
        editorSchema.nodes.table_cell.create(null, paragraph("墨排")),
        editorSchema.nodes.table_cell.create(null, paragraph("编辑器")),
      ]),
    ]);

    expect(serializeMarkdown(editorSchema.nodes.doc.create(null, [table]))).toContain(
      "| 名称 | 描述 |\n| --- | --- |\n| 墨排 | 编辑器 |",
    );
  });
});
