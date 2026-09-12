import type { EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";

import { editorSchema } from "../core/schema";

import type { EditorPlugin } from "./types";

export const linkPlugin: EditorPlugin = { id: "link" };

export const getLinkAtSelection = (state: EditorState) => {
  const { from, to, $from } = state.selection;
  let link = (state.storedMarks || $from.marks()).find(
    (mark) => mark.type === editorSchema.marks.link,
  );
  if (!link && from !== to) {
    state.doc.nodesBetween(from, to, (node) => {
      link ||= node.marks.find((mark) => mark.type === editorSchema.marks.link);
      return !link;
    });
  }
  return link;
};

export const normalizeLink = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (/^(https?:|mailto:|tel:|#)/i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
};

export const applyLink = (view: EditorView, from: number, to: number, href: string) => {
  view.dispatch(view.state.tr.addMark(from, to, editorSchema.marks.link.create({ href })));
};

export const removeLink = (view: EditorView, from: number, to: number) => {
  view.dispatch(view.state.tr.removeMark(from, to, editorSchema.marks.link));
};
