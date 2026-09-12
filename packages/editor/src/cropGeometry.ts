import type { ImageDraft } from "./imageTypes";

export type CropGeometry = {
  sourceWidth: number;
  sourceHeight: number;
  cropWidth: number;
  cropHeight: number;
  cropX: number;
  cropY: number;
  cropFrameWidth: number;
  cropFrameHeight: number;
  cropFrameLeft: number;
  cropFrameTop: number;
  cropMaxX: number;
  cropMaxY: number;
  cropOffsetX: number;
  cropOffsetY: number;
};

const positive = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

export const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export function getCropGeometry(
  draft: ImageDraft,
  source: { width: number; height: number },
): CropGeometry {
  const sourceWidth = positive(draft.cropSourceWidth, source.width);
  const sourceHeight = positive(draft.cropSourceHeight, source.height);
  const cropWidth = clamp(
    positive(draft.cropWidth, Math.round(sourceWidth * 0.86)),
    1,
    sourceWidth,
  );
  const cropHeight = clamp(
    positive(draft.cropHeight, Math.round(cropWidth * (sourceHeight / sourceWidth))),
    1,
    sourceHeight,
  );
  const cropFrameWidth = (cropWidth / sourceWidth) * 100;
  const cropFrameHeight = (cropHeight / sourceHeight) * 100;
  const cropX = clamp(Number(draft.cropX ?? 50), 0, 100);
  const cropY = clamp(Number(draft.cropY ?? 50), 0, 100);
  const cropFrameLeft = ((100 - cropFrameWidth) * cropX) / 100;
  const cropFrameTop = ((100 - cropFrameHeight) * cropY) / 100;
  const cropMaxX = Math.max(0, sourceWidth - cropWidth);
  const cropMaxY = Math.max(0, sourceHeight - cropHeight);

  return {
    sourceWidth,
    sourceHeight,
    cropWidth,
    cropHeight,
    cropX,
    cropY,
    cropFrameWidth,
    cropFrameHeight,
    cropFrameLeft,
    cropFrameTop,
    cropMaxX,
    cropMaxY,
    cropOffsetX: Math.round((cropFrameLeft / 100) * sourceWidth),
    cropOffsetY: Math.round((cropFrameTop / 100) * sourceHeight),
  };
}

export function cropDraftUpdate(geometry: CropGeometry, changes: ImageDraft): ImageDraft {
  return {
    cropWidth: geometry.cropWidth,
    cropHeight: geometry.cropHeight,
    cropX: geometry.cropX,
    cropY: geometry.cropY,
    cropSourceWidth: geometry.sourceWidth,
    cropSourceHeight: geometry.sourceHeight,
    ...changes,
  };
}
