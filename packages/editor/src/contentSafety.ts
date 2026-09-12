import type { Mark, Node as PMNode } from "prosemirror-model";
import { Fragment } from "prosemirror-model";

import type { ImageAttributes } from "./imageTypes";

const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
const SAFE_IMAGE_FILTERS = new Set([
  "none",
  "grayscale(1)",
  "sepia(.55)",
  "contrast(1.18) saturate(1.15)",
  "brightness(1.08) saturate(.78)",
]);
const SAFE_TEXT_ALIGNMENTS = new Set(["left", "center", "right", "justify"]);

export const safeLinkHref = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const href = value.trim();
  if (
    !href ||
    [...href].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  )
    return null;
  if (href.startsWith("#")) return /^#[^\s]*$/.test(href) ? href : null;
  try {
    return SAFE_LINK_PROTOCOLS.has(new URL(href).protocol.toLowerCase()) ? href : null;
  } catch {
    return null;
  }
};

const safeColor = (value: unknown) =>
  typeof value === "string" && /^#[\da-f]{3,8}$/i.test(value) ? value : null;
const safeFontSize = (value: unknown) =>
  typeof value === "string" && /^(?:[89]|[1-6]\d|7[0-2])px$/.test(value) ? value : null;
const safeTextAlign = (value: unknown) =>
  typeof value === "string" && SAFE_TEXT_ALIGNMENTS.has(value) ? value : "left";
const positiveNumber = (value: unknown, max = 10_000) => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number <= max ? number : null;
};
const percentage = (value: unknown, fallback: number) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(100, Math.max(0, number)) : fallback;
};
const nullableText = (value: unknown) => (typeof value === "string" ? value : null);

export const sanitizeImageAttributes = (attrs: Record<string, unknown>): ImageAttributes => ({
  src: typeof attrs.src === "string" ? attrs.src : null,
  alt: nullableText(attrs.alt),
  title: nullableText(attrs.title),
  caption: nullableText(attrs.caption),
  width: positiveNumber(attrs.width),
  cropHeight: positiveNumber(attrs.cropHeight),
  cropWidth: positiveNumber(attrs.cropWidth),
  cropX: percentage(attrs.cropX, 50),
  cropY: percentage(attrs.cropY, 50),
  cropSourceWidth: positiveNumber(attrs.cropSourceWidth),
  cropSourceHeight: positiveNumber(attrs.cropSourceHeight),
  filter:
    typeof attrs.filter === "string" && SAFE_IMAGE_FILTERS.has(attrs.filter)
      ? (attrs.filter as Exclude<ImageAttributes["filter"], undefined>)
      : "none",
  align:
    typeof attrs.align === "string" && ["left", "center", "right"].includes(attrs.align)
      ? (attrs.align as Exclude<ImageAttributes["align"], undefined>)
      : "center",
});

const sanitizeMarks = (marks: readonly Mark[]) =>
  marks.flatMap((mark) => {
    if (mark.type.name === "link") {
      const href = safeLinkHref(mark.attrs.href);
      return href ? [mark.type.create({ ...mark.attrs, href })] : [];
    }
    if (mark.type.name === "text_color" || mark.type.name === "background_color") {
      const color = safeColor(mark.attrs.color);
      return color ? [mark.type.create({ color })] : [];
    }
    if (mark.type.name === "font_size") {
      const size = safeFontSize(mark.attrs.size);
      return size ? [mark.type.create({ size })] : [];
    }
    return [mark];
  });

/** Normalizes every untrusted document boundary before it reaches the editor or renderer. */
export const sanitizeEditorDocument = (node: PMNode): PMNode => {
  const marks = sanitizeMarks(node.marks);
  if (node.isText) return node.mark(marks);
  const content = node.content.size
    ? Fragment.fromArray(node.content.content.map(sanitizeEditorDocument))
    : node.content;
  const attrs =
    node.type.name === "image"
      ? sanitizeImageAttributes(node.attrs)
      : node.type.name === "paragraph" || node.type.name === "heading"
        ? { ...node.attrs, textAlign: safeTextAlign(node.attrs.textAlign) }
        : node.attrs;
  return node.type.create(attrs, content, marks);
};
