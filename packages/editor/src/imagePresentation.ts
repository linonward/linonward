import type { ImageAlignment, ImageAttributes, ImageFilter } from "./imageTypes";

type ImagePresentationOptions = { margin: string; includeAutoWidth?: boolean };

const filters: ReadonlySet<ImageFilter> = new Set([
  "none",
  "grayscale(1)",
  "sepia(.55)",
  "contrast(1.18) saturate(1.15)",
  "brightness(1.08) saturate(.78)",
]);

const number = (value: unknown) => {
  const result = Number(value);
  return Number.isFinite(result) && result > 0 ? result : null;
};

const alignmentMargin = (align: ImageAlignment | null | undefined, margin: string) =>
  align === "left"
    ? `${margin} auto ${margin} 0`
    : align === "right"
      ? `${margin} 0 ${margin} auto`
      : `${margin} auto`;

export const safeImageFilter = (filter: unknown): ImageFilter =>
  typeof filter === "string" && filters.has(filter as ImageFilter)
    ? (filter as ImageFilter)
    : "none";

export const imageCaption = (attrs: ImageAttributes) => attrs.caption || attrs.alt || "";

export const imageFigureStyle = (align: ImageAlignment | null | undefined) =>
  `margin:22px 0;text-align:${align || "center"}`;

export const imageCaptionStyle =
  "margin-top:8px;color:#747987;font-size:13px;line-height:1.5;text-align:center";

export function imagePresentation(attrs: ImageAttributes, options: ImagePresentationOptions) {
  const { margin, includeAutoWidth = false } = options;
  const width = number(attrs.width);
  const cropWidth = number(attrs.cropWidth);
  const cropHeight = number(attrs.cropHeight);
  const sourceWidth = number(attrs.cropSourceWidth);
  const sourceHeight = number(attrs.cropSourceHeight);
  const filter = safeImageFilter(attrs.filter);
  const imageFilter = filter === "none" ? "" : `filter:${filter};`;
  const frameMargin = alignmentMargin(attrs.align, margin);

  if (cropWidth && cropHeight && sourceWidth && sourceHeight) {
    const cropX = Math.min(100, Math.max(0, Number(attrs.cropX) || 50));
    const cropY = Math.min(100, Math.max(0, Number(attrs.cropY) || 50));
    const left = Math.max(0, sourceWidth - cropWidth) * (cropX / 100);
    const top = Math.max(0, sourceHeight - cropHeight) * (cropY / 100);
    return {
      frameStyle: `display:block;overflow:hidden;max-width:100%;width:${cropWidth}px;aspect-ratio:${cropWidth}/${cropHeight};margin:${frameMargin}`,
      imageStyle: `display:block;max-width:none;width:${(sourceWidth / cropWidth) * 100}%;height:${(sourceHeight / cropHeight) * 100}%;transform:translate(${(-left / sourceWidth) * 100}%,${(-top / sourceHeight) * 100}%);${imageFilter}`,
    };
  }

  return {
    frameStyle: null,
    imageStyle: [
      "display:block",
      `margin:${frameMargin}`,
      "max-width:100%",
      width
        ? `width:${width}px`
        : cropWidth
          ? `width:${cropWidth}px`
          : cropHeight
            ? "width:100%"
            : includeAutoWidth
              ? "width:auto"
              : "",
      cropHeight ? `height:${cropHeight}px` : "height:auto",
      cropHeight ? "object-fit:cover" : "",
      cropHeight
        ? `object-position:${Math.min(100, Math.max(0, Number(attrs.cropX) || 50))}% ${Math.min(100, Math.max(0, Number(attrs.cropY) || 50))}%`
        : "",
      imageFilter,
    ]
      .filter(Boolean)
      .join(";"),
  };
}
