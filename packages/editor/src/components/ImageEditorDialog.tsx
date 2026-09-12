"use client";
import { Maximize2, Replace } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { clamp, cropDraftUpdate, getCropGeometry } from "../cropGeometry";
import type { ImageAlignment, ImageAttributes, ImageDraft, ImageFilter } from "../imageTypes";

import Modal from "./Modal";

export type { ImageAttributes } from "../imageTypes";

type CropDrag = {
  mode: "move" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";
  startX: number;
  startY: number;
  width: number;
  height: number;
  x: number;
  y: number;
  sourceWidth: number;
  sourceHeight: number;
};

export default function ImageEditorDialog({
  image,
  draft,
  imageWidth,
  onChange,
  onClose,
  onConfirm,
  onReplace,
}: {
  image: ImageAttributes;
  draft: ImageDraft;
  imageWidth: number;
  onChange: (attrs: ImageDraft) => void;
  onClose: () => void;
  onConfirm: () => void;
  onReplace: () => void;
}) {
  const cropDrag = useRef<CropDrag | null>(null);
  const cropStage = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (!cropStage.current) return;
    const stage = cropStage.current;
    const measure = () => setStageSize({ width: stage.clientWidth, height: stage.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    measure();
    return () => observer.disconnect();
  }, []);

  const stageWidth = stageSize.width || imageWidth;
  const stageHeight = stageSize.height || imageWidth;
  const geometry = getCropGeometry(draft, {
    width: naturalSize.width || imageWidth,
    height: naturalSize.height || imageWidth * (stageHeight / stageWidth),
  });
  const {
    sourceWidth,
    sourceHeight,
    cropWidth,
    cropHeight,
    cropFrameWidth,
    cropFrameHeight,
    cropFrameLeft,
    cropFrameTop,
    cropMaxX,
    cropMaxY,
    cropOffsetX,
    cropOffsetY,
  } = geometry;
  const cropStageWidth = Math.min(stageSize.width || 320, (320 * sourceWidth) / sourceHeight);
  const cropUpdate = (changes: ImageDraft) => cropDraftUpdate(geometry, changes);

  const beginCropDrag = (event: React.PointerEvent<HTMLElement>, mode: CropDrag["mode"]) => {
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    cropDrag.current = {
      mode,
      startX: event.clientX,
      startY: event.clientY,
      width: cropWidth,
      height: cropHeight,
      x: Number(draft.cropX ?? 50),
      y: Number(draft.cropY ?? 50),
      sourceWidth,
      sourceHeight,
    };
  };

  const moveCropDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = cropDrag.current;
    if (!drag) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const dx = ((event.clientX - drag.startX) / bounds.width) * drag.sourceWidth;
    const dy = ((event.clientY - drag.startY) / bounds.height) * drag.sourceHeight;
    if (drag.mode === "move") {
      onChange({
        cropWidth: drag.width,
        cropHeight: drag.height,
        cropX: clamp(drag.x + ((event.clientX - drag.startX) / bounds.width) * 100, 0, 100),
        cropY: clamp(drag.y + ((event.clientY - drag.startY) / bounds.height) * 100, 0, 100),
        cropSourceWidth: drag.sourceWidth,
        cropSourceHeight: drag.sourceHeight,
      });
      return;
    }
    const isLeft = drag.mode === "nw" || drag.mode === "w" || drag.mode === "sw";
    const isTop = drag.mode === "nw" || drag.mode === "n" || drag.mode === "ne";
    const horizontal = drag.mode === "n" || drag.mode === "s" ? 0 : isLeft ? -dx : dx;
    const vertical = drag.mode === "e" || drag.mode === "w" ? 0 : isTop ? -dy : dy;
    const isCorner = ["nw", "ne", "se", "sw"].includes(drag.mode);
    const aspectRatio = drag.width / drag.height;
    const maxHeight = drag.sourceHeight;
    const maxCornerWidth = Math.min(drag.sourceWidth, maxHeight * aspectRatio);
    const nextWidth = isCorner
      ? clamp(
          Math.abs(horizontal) >= Math.abs(vertical * aspectRatio)
            ? drag.width + horizontal
            : (drag.height + vertical) * aspectRatio,
          120,
          maxCornerWidth,
        )
      : clamp(drag.width + horizontal, 120, drag.sourceWidth);
    const nextHeight = isCorner
      ? nextWidth / aspectRatio
      : clamp(drag.height + vertical, 120, maxHeight);
    const frameWidth = (width: number) => (width / drag.sourceWidth) * 100;
    const frameHeight = (height: number) => (height / drag.sourceHeight) * 100;
    const oldFrameWidth = frameWidth(drag.width);
    const oldFrameHeight = frameHeight(drag.height);
    const nextFrameWidth = frameWidth(nextWidth);
    const nextFrameHeight = frameHeight(nextHeight);
    const oldLeft = ((100 - oldFrameWidth) * drag.x) / 100;
    const oldTop = ((100 - oldFrameHeight) * drag.y) / 100;
    const nextLeft = clamp(
      isLeft ? oldLeft + oldFrameWidth - nextFrameWidth : oldLeft,
      0,
      100 - nextFrameWidth,
    );
    const nextTop = clamp(
      isTop ? oldTop + oldFrameHeight - nextFrameHeight : oldTop,
      0,
      100 - nextFrameHeight,
    );
    onChange({
      cropWidth: nextWidth,
      cropHeight: nextHeight,
      cropX: nextFrameWidth === 100 ? 50 : (nextLeft / (100 - nextFrameWidth)) * 100,
      cropY: nextFrameHeight === 100 ? 50 : (nextTop / (100 - nextFrameHeight)) * 100,
      cropSourceWidth: drag.sourceWidth,
      cropSourceHeight: drag.sourceHeight,
    });
  };

  return (
    <Modal
      title="编辑图片"
      description="调整图片裁剪，或替换为另一张图片。"
      onClose={onClose}
      className="image-modal"
      footer={
        <button type="button" onClick={onConfirm}>
          确定
        </button>
      }
    >
      <div className="image-modal-content">
        <div
          ref={cropStage}
          className="crop-stage"
          aria-label="图片裁剪预览"
          style={{ aspectRatio: `${sourceWidth}/${sourceHeight}`, width: `${cropStageWidth}px` }}
          onPointerMove={moveCropDrag}
          onPointerUp={() => {
            cropDrag.current = null;
          }}
          onPointerCancel={() => {
            cropDrag.current = null;
          }}
        >
          <img
            src={String(draft.src || image.src)}
            alt={String(draft.alt || image.alt || "")}
            style={{ filter: String(draft.filter || "none") }}
            onLoad={(event) =>
              setNaturalSize({
                width: event.currentTarget.naturalWidth,
                height: event.currentTarget.naturalHeight,
              })
            }
          />
          <div
            className="crop-frame"
            style={{
              width: `${cropFrameWidth}%`,
              height: `${cropFrameHeight}%`,
              left: `${cropFrameLeft}%`,
              top: `${cropFrameTop}%`,
            }}
            onPointerDown={(event) => beginCropDrag(event, "move")}
          >
            {(["nw", "n", "ne", "w", "e", "sw", "s", "se"] as const).map((mode) => (
              <i
                key={mode}
                className={`crop-handle crop-handle-${mode}`}
                onPointerDown={(event) => beginCropDrag(event, mode)}
              />
            ))}
          </div>
        </div>
        <div className="image-modal-controls">
          <div className="image-modal-actions">
            <button type="button" onClick={onReplace}>
              <Replace size={17} /> 替换图片
            </button>
            <button
              type="button"
              onClick={() =>
                onChange({ width: null, cropHeight: null, cropWidth: null, cropX: 50, cropY: 50 })
              }
            >
              <Maximize2 size={17} /> 自适应
            </button>
          </div>
          <fieldset className="image-setting">
            <legend>图例</legend>
            <input
              aria-label="图片图例"
              value={String(draft.caption ?? image.caption ?? image.alt ?? "")}
              onChange={(event) => onChange({ caption: event.target.value })}
            />
          </fieldset>
          <fieldset className="image-setting">
            <legend>滤镜</legend>
            <select
              aria-label="图片滤镜"
              value={String(draft.filter || "none")}
              onChange={(event) => onChange({ filter: event.target.value as ImageFilter })}
            >
              <option value="none">原图</option>
              <option value="grayscale(1)">黑白</option>
              <option value="sepia(.55)">复古</option>
              <option value="contrast(1.18) saturate(1.15)">鲜明</option>
              <option value="brightness(1.08) saturate(.78)">柔和</option>
            </select>
          </fieldset>
          <fieldset className="image-fine-tune">
            <legend>微调裁剪</legend>
            <label>
              宽度 (px)
              <input
                aria-label="裁剪宽度"
                type="number"
                min="120"
                max={sourceWidth}
                value={Math.round(cropWidth)}
                onChange={(event) =>
                  onChange(
                    cropUpdate({
                      cropWidth: Math.min(sourceWidth, Math.max(120, Number(event.target.value))),
                    }),
                  )
                }
              />
            </label>
            <label>
              高度 (px)
              <input
                aria-label="裁剪高度"
                type="number"
                min="120"
                max={sourceHeight}
                value={Math.round(cropHeight)}
                onChange={(event) =>
                  onChange(
                    cropUpdate({
                      cropHeight: Math.min(sourceHeight, Math.max(120, Number(event.target.value))),
                    }),
                  )
                }
              />
            </label>
            <label>
              位置 X (px)
              <input
                aria-label="裁剪位置 X"
                type="number"
                min="0"
                max={cropMaxX}
                value={cropOffsetX}
                disabled={cropMaxX === 0}
                onChange={(event) =>
                  onChange(cropUpdate({ cropX: (Number(event.target.value) / cropMaxX) * 100 }))
                }
              />
            </label>
            <label>
              位置 Y (px)
              <input
                aria-label="裁剪位置 Y"
                type="number"
                min="0"
                max={cropMaxY}
                value={cropOffsetY}
                disabled={cropMaxY === 0}
                onChange={(event) =>
                  onChange(cropUpdate({ cropY: (Number(event.target.value) / cropMaxY) * 100 }))
                }
              />
            </label>
          </fieldset>
          <fieldset className="image-setting">
            <legend>对齐方式</legend>
            <div className="alignment-options" role="group" aria-label="图片对齐方式">
              {[
                ["left", "左对齐"],
                ["center", "居中"],
                ["right", "右对齐"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  className={draft.align === value ? "selected" : ""}
                  aria-pressed={draft.align === value}
                  onClick={() => onChange({ align: value as ImageAlignment })}
                >
                  {label}
                </button>
              ))}
            </div>
          </fieldset>
        </div>
      </div>
    </Modal>
  );
}
