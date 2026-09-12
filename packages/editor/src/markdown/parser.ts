import {
  MarkdownParser,
  MarkdownSerializer,
  defaultMarkdownParser,
  defaultMarkdownSerializer,
} from "prosemirror-markdown";
import type { Node as PMNode } from "prosemirror-model";

import { sanitizeEditorDocument } from "../contentSafety";
import { editorSchema } from "../core/schema";

// Markdown exported by the editor uses <u> because CommonMark has no underline syntax.
// Enable inline HTML only to turn that tag back into the editor's underline mark.
const markdownTokenizer = defaultMarkdownParser.tokenizer;
markdownTokenizer.set({ html: true });
markdownTokenizer.enable("strikethrough");

type InlineToken = {
  type: string;
  tag: string;
  nesting: number;
  content: string;
  meta?: Record<string, string>;
};

const imageMetadata = (attrs: Record<string, unknown>) =>
  `<!--linonward-image:${encodeURIComponent(JSON.stringify(attrs))}-->`;

const parseImageMetadata = (value: string) => {
  const encoded = value.trim().match(/^<!--(?:linonward|mopai)-image:([^>]+)-->$/i)?.[1];
  if (!encoded) return null;
  try {
    const metadata: unknown = JSON.parse(decodeURIComponent(encoded));
    return metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

type BlockImage = { placeholder: string; attrs: Record<string, unknown> };

const extractBlockImages = (markdown: string) => {
  const images: BlockImage[] = [];
  const source = markdown.replace(
    /^!\[([^\]]*)\]\(([^()\s]+)(?:\s+"((?:\\.|[^"])*)")?\)(<!--(?:linonward|mopai)-image:[^>]+-->)?\s*$/gm,
    (_match, alt: string, src: string, title: string | undefined, comment: string | undefined) => {
      const placeholder = `MOPAI_IMAGE_${images.length}`;
      images.push({
        placeholder,
        attrs: {
          src: src.replace(/\\([()])/g, "$1"),
          alt,
          title: title?.replace(/\\"/g, '"') || null,
          ...(parseImageMetadata(comment || "") || {}),
        },
      });
      return placeholder;
    },
  );
  return { images, source };
};

const styledSpan =
  /^<(?:linonward|mopai)-(text-color|background-color|font-size) value="([^"]+)">$/i;

const preserveEditorMarks = (token: InlineToken) => {
  const match = token.content.trim().match(styledSpan);
  const markName = match?.[1];
  const markValue = match?.[2];
  if (markName && markValue) {
    token.type = `${markName.replace(/-/g, "_")}_open`;
    token.tag = `linonward-${markName}`;
    token.nesting = 1;
    token.meta = markName === "font-size" ? { size: markValue } : { color: markValue };
    return;
  }
  if (/^<(?:linonward|mopai)-marker>$/i.test(token.content.trim())) {
    token.type = "marker_open";
    token.tag = "linonward-marker";
    token.nesting = 1;
    return;
  }
  const close = token.content
    .trim()
    .match(/^<\/(?:linonward|mopai)-(text-color|background-color|font-size|marker)>$/i);
  const closingMarkName = close?.[1];
  if (closingMarkName) {
    token.type = `${closingMarkName.replace(/-/g, "_")}_close`;
    token.tag = `linonward-${closingMarkName}`;
    token.nesting = -1;
  }
};
markdownTokenizer.core.ruler.after("inline", "editor_underline_html", (state) => {
  for (const token of state.tokens) {
    for (const child of token.children || []) {
      if (child.type !== "html_inline") continue;
      const html = child.content.trim().toLowerCase();
      if (html === "<u>") {
        child.type = "underline_open";
        child.tag = "u";
        child.nesting = 1;
      } else if (html === "</u>") {
        child.type = "underline_close";
        child.tag = "u";
        child.nesting = -1;
      } else {
        preserveEditorMarks(child as InlineToken);
        if (child.type === "html_inline") {
          child.type = "text";
          child.content = "";
        }
      }
    }
  }
});

const horizontalWhitespace = /[\t \u00a0\u200b\u3000]+$/;

// Some generators emit loose bold syntax such as `** text **` and `#####** title**`.
// CommonMark treats these delimiters as literal text, so repair each delimiter pair before parsing.
const normalizeLooseStrongSegment = (markdown: string) => {
  let result = "";
  let cursor = 0;
  let isOpen = false;

  while (cursor < markdown.length) {
    const delimiter = markdown.indexOf("**", cursor);
    if (delimiter < 0) return result + markdown.slice(cursor);

    result += markdown.slice(cursor, delimiter);
    cursor = delimiter + 2;
    if (!isOpen) {
      result += "**";
      while (["\t", " ", "\u00a0", "\u200b", "\u3000"].includes(markdown[cursor] ?? "")) cursor++;
      isOpen = true;
      continue;
    }

    const trailingWhitespace = result.match(horizontalWhitespace)?.[0] || "";
    result = result.slice(0, result.length - trailingWhitespace.length);
    result += `**${trailingWhitespace}`;
    // CommonMark cannot close a strong delimiter directly before a CJK character.
    // An ignored HTML comment provides a zero-width delimiter boundary without altering text.
    const nextCharacter = markdown[cursor];
    if (nextCharacter && !/\s/u.test(nextCharacter)) result += "<!-- -->";
    isOpen = false;
  }

  return result;
};

const normalizeLooseStrongDelimiters = (markdown: string) =>
  markdown
    .replace(/^( {0,3}#{1,6})(?=\*\*)/gm, "$1 ")
    .split(/(`{3,}[\s\S]*?`{3,}|~{3,}[\s\S]*?~{3,})/g)
    .map((segment) =>
      /^(?:`{3,}|~{3,})/.test(segment) ? segment : normalizeLooseStrongSegment(segment),
    )
    .join("");

const restoreBlockImages = (document: PMNode, images: readonly BlockImage[]) => {
  const byPlaceholder = new Map(images.map((image) => [image.placeholder, image.attrs]));
  const content: PMNode[] = [];
  document.forEach((node) => {
    const attrs = node.type.name === "paragraph" ? byPlaceholder.get(node.textContent) : null;
    content.push(attrs ? editorSchema.nodes.image.create(attrs) : node);
  });
  return editorSchema.nodes.doc.create(null, content);
};

const markdownSerializer = new MarkdownSerializer(
  {
    ...defaultMarkdownSerializer.nodes,
    image: (state, node) => {
      const { src, alt, title, ...metadata } = node.attrs;
      state.write(
        `![${state.esc(alt || "")}](${String(src).replace(/[()]/g, "\\$&")}${title ? ` "${String(title).replace(/"/g, '\\"')}"` : ""})${imageMetadata(metadata)}`,
      );
      state.closeBlock(node);
    },
    table: (state, node) => {
      const rows: string[][] = [];
      node.forEach((row) => {
        const cells: string[] = [];
        row.forEach((cell) => cells.push(cell.textContent.replace(/\|/g, "\\\\|")));
        rows.push(cells);
      });
      const firstRow = rows[0];
      if (!firstRow) return;
      state.write(`| ${firstRow.join(" | ")} |`);
      state.ensureNewLine();
      state.write(`| ${firstRow.map(() => "---").join(" | ")} |`);
      rows.slice(1).forEach((row) => {
        state.ensureNewLine();
        state.write(`| ${row.join(" | ")} |`);
      });
      state.closeBlock(node);
    },
  },
  {
    ...defaultMarkdownSerializer.marks,
    underline: { open: "<u>", close: "</u>" },
    strikethrough: { open: "~~", close: "~~", mixable: true, expelEnclosingWhitespace: true },
    text_color: {
      open: (_state, mark) => `<linonward-text-color value="${mark.attrs.color}">`,
      close: "</linonward-text-color>",
    },
    background_color: {
      open: (_state, mark) => `<linonward-background-color value="${mark.attrs.color}">`,
      close: "</linonward-background-color>",
    },
    marker: { open: "<linonward-marker>", close: "</linonward-marker>" },
    font_size: {
      open: (_state, mark) => `<linonward-font-size value="${mark.attrs.size}">`,
      close: "</linonward-font-size>",
    },
  },
);
export const parseMarkdown = (markdown: string) => {
  const { source, images } = extractBlockImages(normalizeLooseStrongDelimiters(markdown));
  return sanitizeEditorDocument(
    restoreBlockImages(
      new MarkdownParser(editorSchema, markdownTokenizer, {
        ...defaultMarkdownParser.tokens,
        underline: { mark: "underline" },
        s: { mark: "strikethrough" },
        html_inline: { ignore: true },
        html_block: { ignore: true },
        text_color: { mark: "text_color", getAttrs: (token) => token.meta as { color: string } },
        background_color: {
          mark: "background_color",
          getAttrs: (token) => token.meta as { color: string },
        },
        font_size: { mark: "font_size", getAttrs: (token) => token.meta as { size: string } },
        marker: { mark: "marker" },
      }).parse(source),
      images,
    ),
  );
};
export const serializeMarkdown = (doc: Parameters<typeof defaultMarkdownSerializer.serialize>[0]) =>
  markdownSerializer.serialize(doc);
