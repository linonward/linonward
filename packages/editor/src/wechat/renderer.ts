import type { Mark, Node as PMNode } from "prosemirror-model";

import { safeLinkHref } from "../contentSafety";
import {
  imageCaption,
  imageCaptionStyle,
  imageFigureStyle,
  imagePresentation,
} from "../imagePresentation";
import type { Theme } from "../themes/types";
const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const style = (o: Record<string, string>) =>
  Object.entries(o)
    .map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}:${v}`)
    .join(";");
const token = (theme: Theme, name: keyof Theme["editorTokens"]) => theme.editorTokens[name];
const marks = (text: string, m: readonly Mark[], t: Theme) =>
  m.reduceRight(
    (o, x) =>
      x.type.name === "strong"
        ? `<strong>${o}</strong>`
        : x.type.name === "em"
          ? `<em>${o}</em>`
          : x.type.name === "underline"
            ? `<u style="text-decoration-thickness:1px;text-underline-offset:3px">${o}</u>`
            : x.type.name === "strikethrough"
              ? `<s style="text-decoration-thickness:1px;text-decoration-color:currentColor">${o}</s>`
              : x.type.name === "code"
                ? `<code style="${style(t.inlineCode)}">${o}</code>`
                : x.type.name === "link"
                  ? (() => {
                      const href = safeLinkHref(x.attrs.href);
                      return href ? `<a href="${esc(href)}" style="${style(t.link)}">${o}</a>` : o;
                    })()
                  : x.type.name === "text_color"
                    ? `<span style="color:${esc(x.attrs.color)}">${o}</span>`
                    : x.type.name === "background_color"
                      ? `<span style="background-color:${esc(x.attrs.color)}">${o}</span>`
                      : x.type.name === "marker"
                        ? `<mark style="background:linear-gradient(transparent 42%,#fff2a8 42%,#fff2a8 88%,transparent 88%);padding:0 0.08em;border-radius:0.12em;box-decoration-break:clone">${o}</mark>`
                        : x.type.name === "font_size"
                          ? `<span style="font-size:${esc(x.attrs.size)}">${o}</span>`
                          : o,
    text,
  );
export function renderWechatHtml(doc: PMNode, t: Theme) {
  const isList = (node: PMNode | undefined) =>
    node?.type.name === "bullet_list" || node?.type.name === "ordered_list";
  const renderParagraph = (node: PMNode, margin?: string) => {
    const paragraph = {
      ...t.paragraph,
      ...(margin ? { margin } : {}),
      textAlign: node.attrs.textAlign || "left",
    };
    return `<p style="${style(paragraph)}">${node.content.size ? renderChildren(node) : "<br>"}</p>`;
  };
  const renderList = (node: PMNode, margin?: string) => {
    const list = {
      ...(node.type.name === "ordered_list" ? t.orderedList : t.bulletList),
      ...(margin ? { margin } : {}),
    };
    const tag = node.type.name === "ordered_list" ? "ol" : "ul";
    return `<${tag} style="${style(list)}">${renderChildren(node)}</${tag}>`;
  };
  const renderListItem = (node: PMNode) => {
    let content = "";
    node.forEach((child) => {
      content +=
        child.type.name === "paragraph"
          ? renderParagraph(child, "0")
          : isList(child)
            ? renderList(child, "8px 0 2px")
            : r(child);
    });
    return `<li>${content}</li>`;
  };
  const renderDocument = (node: PMNode) => {
    const children: PMNode[] = [];
    node.forEach((child) => children.push(child));
    let content = "";
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      if (!child) continue;
      const next = children[index + 1];
      if (child.type.name === "paragraph" && next && isList(next)) {
        content += `<section data-editor-list-block style="margin:8px 0 18px">${renderParagraph(child, "0 0 8px")}${renderList(next, "0")}</section>`;
        index += 1;
      } else {
        content += r(child);
      }
    }
    return content;
  };
  const renderChildren = (node: PMNode) => {
    let content = "";
    node.forEach((child) => (content += r(child)));
    return content;
  };
  const r = (n: PMNode): string => {
    if (n.isText) return marks(esc(n.text || ""), n.marks, t);
    switch (n.type.name) {
      case "doc":
        return `<section style="${style(t.article)}">${renderDocument(n)}</section>`;
      case "paragraph":
        return renderParagraph(n);
      case "heading":
        return `<h${n.attrs.level} style="${style({ ...(t.headings[`h${n.attrs.level}`] || t.headings.h3), textAlign: n.attrs.textAlign || "left" })}">${renderChildren(n)}</h${n.attrs.level}>`;
      case "blockquote":
        return `<blockquote style="${style(t.blockquote)}">${renderChildren(n)}</blockquote>`;
      case "bullet_list":
      case "ordered_list":
        return renderList(n);
      case "list_item":
        return renderListItem(n);
      case "table":
        return `<table style="width:100%;margin:22px 0;border-collapse:collapse;border:1px solid ${token(t, "--richtext-table-border")};font-family:Arial,'PingFang SC','Microsoft YaHei',sans-serif;font-size:14px;line-height:1.6">${renderChildren(n)}</table>`;
      case "table_row":
        return `<tr>${renderChildren(n)}</tr>`;
      case "table_header":
        return `<th style="padding:10px 12px;border:1px solid ${token(t, "--richtext-table-cell-border")};background:${token(t, "--richtext-table-heading-background")};color:${token(t, "--richtext-table-heading-text")};text-align:left;font-weight:700">${renderChildren(n)}</th>`;
      case "table_cell":
        return `<td style="padding:10px 12px;border:1px solid ${token(t, "--richtext-table-cell-border")};color:${token(t, "--richtext-body")};vertical-align:top">${renderChildren(n)}</td>`;
      case "code_block":
        return `<pre style="${style(t.codeBlock)}"><code>${esc(n.textContent)}</code></pre>`;
      case "horizontal_rule":
        return `<hr style="${style(t.horizontalRule)}">`;
      case "image": {
        if (!(/^https?:\/\//.test(n.attrs.src) || n.attrs.src.startsWith("data:image"))) {
          return `<section style="border:1px dashed #c9cbd4;color:#8b909d;padding:28px;text-align:center;margin:22px 0">无法读取本地图片<br>${esc(n.attrs.src)}</section>`;
        }
        const caption = imageCaption(n.attrs);
        const presentation = imagePresentation(n.attrs, { margin: "0", includeAutoWidth: true });
        const image = `<img src="${esc(n.attrs.src)}" alt="${esc(n.attrs.alt || "")}" style="${presentation.imageStyle}">`;
        const content = presentation.frameStyle
          ? `<span style="${presentation.frameStyle}">${image}</span>`
          : image;
        return `<figure style="${imageFigureStyle(n.attrs.align)}">${content}<figcaption style="${imageCaptionStyle}">${esc(caption)}</figcaption></figure>`;
      }
      default:
        return renderChildren(n);
    }
  };
  return r(doc);
}
