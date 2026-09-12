import type { Command, EditorState } from "prosemirror-state";

import type { EditorPlugin } from "./types";

export type TextAlign = "left" | "center" | "right" | "justify";

const textBlocks = new Set(["paragraph", "heading"]);

export const setTextAlign =
  (textAlign: TextAlign): Command =>
  (state, dispatch) => {
    const changes: Array<{ pos: number; attrs: Record<string, unknown> }> = [];
    state.doc.nodesBetween(state.selection.from, state.selection.to, (node, pos) => {
      if (textBlocks.has(node.type.name) && node.attrs.textAlign !== textAlign) {
        changes.push({ pos, attrs: { ...node.attrs, textAlign } });
      }
    });
    if (!changes.length) return false;
    if (dispatch) {
      let transaction = state.tr;
      for (const change of changes) {
        transaction = transaction.setNodeMarkup(change.pos, undefined, change.attrs);
      }
      dispatch(transaction);
    }
    return true;
  };

export const currentTextAlign = (state: EditorState): TextAlign => {
  const node = state.selection.$from.parent;
  return (node.attrs.textAlign as TextAlign | undefined) ?? "left";
};

export const textAlignPlugin: EditorPlugin = { id: "text-align" };
