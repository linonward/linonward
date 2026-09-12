import type { Mark } from "prosemirror-model";
import type { Command, EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

import { editorSchema } from "../core/schema";

import type { EditorPlugin } from "./types";

type TextStyleMark = "text_color" | "background_color";

export const textStylePlugin: EditorPlugin = { id: "text-style" };

export const selectedTextStyleColor = (
  state: EditorState,
  markName: TextStyleMark,
  fallback: string,
) => {
  const { from, to, $from } = state.selection;
  if (from === to) {
    const mark = (state.storedMarks || $from.marks()).find(
      (entry) => entry.type === editorSchema.marks[markName],
    );
    return typeof mark?.attrs.color === "string" ? mark.attrs.color : fallback;
  }

  let color: string | null = null;
  let seen = false;
  let mixed = false;
  state.doc.nodesBetween(from, to, (node) => {
    if (!node.isText || mixed) return;
    const mark = node.marks.find((entry) => entry.type === editorSchema.marks[markName]);
    const nextColor = typeof mark?.attrs.color === "string" ? mark.attrs.color : null;
    if (!seen) {
      color = nextColor;
      seen = true;
    } else if (color !== nextColor) mixed = true;
  });
  return mixed || !seen || color === null ? fallback : color;
};

export const applyTextStyle = (
  view: EditorView,
  mark: TextStyleMark,
  color: string,
  fallback?: string,
) => {
  const { state } = view;
  view.dispatch(
    state.tr.addMark(
      state.selection.from,
      state.selection.to,
      editorSchema.marks[mark].create({ color: fallback ?? color }),
    ),
  );
};

export const applyFontSize = (
  view: EditorView,
  size: string,
  selection: Pick<EditorState["selection"], "from" | "to">,
) => {
  view.dispatch(
    view.state.tr.addMark(
      selection.from,
      selection.to,
      editorSchema.marks.font_size.create({ size }),
    ),
  );
};

export const captureInlineFormatting = (state: EditorState): readonly Mark[] =>
  state.storedMarks ?? state.selection.$from.marks();

export const applyInlineFormatting =
  (marks: readonly Mark[]): Command =>
  (state, dispatch) => {
    const { from, to } = state.selection;
    if (from === to) return false;
    let transaction = state.tr.removeMark(from, to);
    marks.forEach((mark) => {
      transaction = transaction.addMark(from, to, mark);
    });
    dispatch?.(transaction);
    return true;
  };

export const clearInlineFormatting: Command = (state, dispatch) => {
  const { from, to } = state.selection;
  if (from === to) {
    dispatch?.(state.tr.setStoredMarks([]));
    return true;
  }
  dispatch?.(state.tr.removeMark(from, to));
  return true;
};
