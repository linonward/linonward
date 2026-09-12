import { NodeSelection } from "prosemirror-state";
import type { EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { useCallback, useRef, useState } from "react";
import type { RefObject } from "react";

import type { ImageAttributes, ImageDraft } from "../imageTypes";

export type SelectedImage = {
  pos: number;
  attrs: ImageAttributes;
  displayWidth: number;
  anchor: { left: number; top: number; placeBelow: boolean };
};

export default function useImageEditing(view: RefObject<EditorView | null>) {
  const draftRef = useRef<ImageDraft | null>(null);
  const [selectedImage, setSelectedImage] = useState<SelectedImage | null>(null);
  const [imageDraft, setImageDraft] = useState<ImageDraft | null>(null);
  const [imageEditorOpen, setImageEditorOpen] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const syncSelectedImage = useCallback(
    (state: EditorState) => {
      if (
        !(state.selection instanceof NodeSelection) ||
        state.selection.node.type.name !== "image"
      ) {
        setSelectedImage(null);
        setImageEditorOpen(false);
        setImageDraft(null);
        draftRef.current = null;
        return;
      }
      const image = view.current?.nodeDOM(state.selection.from) as HTMLElement | null;
      if (!image) return;
      const bounds = image.getBoundingClientRect();
      setSelectedImage({
        pos: state.selection.from,
        attrs: state.selection.node.attrs as ImageAttributes,
        displayWidth: Math.round(bounds.width) || 320,
        anchor: {
          left: Math.min(Math.max(bounds.left + bounds.width / 2, 190), window.innerWidth - 190),
          top: bounds.top < 210 ? bounds.bottom + 10 : bounds.top - 10,
          placeBelow: bounds.top < 210,
        },
      });
    },
    [view],
  );
  const updateDraft = useCallback(
    (attrs: ImageDraft) =>
      setImageDraft(
        (draft) =>
          (draftRef.current = {
            ...(draft || draftRef.current || selectedImage?.attrs || {}),
            ...attrs,
          }),
      ),
    [selectedImage],
  );
  const close = useCallback(() => {
    setImageEditorOpen(false);
    setImageDraft(null);
    draftRef.current = null;
  }, []);
  const confirm = useCallback(
    (onConfirm: (draft: ImageDraft) => void) => {
      if (draftRef.current) onConfirm(draftRef.current);
      close();
    },
    [close],
  );
  return {
    selectedImage,
    imageDraft,
    imageEditorOpen,
    uploadingImage,
    setUploadingImage,
    syncSelectedImage,
    updateDraft,
    close,
    confirm,
    open: (imageWidth: number) => {
      if (selectedImage) {
        const previousCropWidth = Number(selectedImage.attrs.cropWidth);
        const previousCropHeight = Number(selectedImage.attrs.cropHeight);
        const draft = {
          ...selectedImage.attrs,
          ...(previousCropWidth && previousCropHeight
            ? {
                cropSourceWidth:
                  Number(selectedImage.attrs.cropSourceWidth) ||
                  Math.max(imageWidth, previousCropWidth / 0.86),
                cropSourceHeight:
                  Number(selectedImage.attrs.cropSourceHeight) ||
                  Math.max(imageWidth, previousCropHeight / 0.86),
              }
            : {}),
        };
        draftRef.current = draft;
        setImageDraft(draft);
        setImageEditorOpen(true);
      }
    },
  };
}
