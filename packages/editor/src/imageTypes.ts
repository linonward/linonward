export type ImageAlignment = "left" | "center" | "right";
export type ImageFilter =
  | "none"
  | "grayscale(1)"
  | "sepia(.55)"
  | "contrast(1.18) saturate(1.15)"
  | "brightness(1.08) saturate(.78)";

export type ImageAttributes = {
  src?: string | null;
  alt?: string | null;
  title?: string | null;
  caption?: string | null;
  width?: number | null;
  cropHeight?: number | null;
  cropWidth?: number | null;
  cropX?: number | null;
  cropY?: number | null;
  cropSourceWidth?: number | null;
  cropSourceHeight?: number | null;
  filter?: ImageFilter | null;
  align?: ImageAlignment | null;
};

export type ImageDraft = ImageAttributes;
