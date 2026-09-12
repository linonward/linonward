import { setBlockType, toggleMark, wrapIn } from "prosemirror-commands";
import { keymap } from "prosemirror-keymap";
import { liftListItem, wrapInList } from "prosemirror-schema-list";
import type { EditorView } from "prosemirror-view";

import { editorSchema } from "../core/schema";

import type { EditorPlugin } from "./types";

export const formattingPlugin: EditorPlugin = {
  id: "formatting",
  createProseMirrorPlugins: () => [
    keymap({
      "Mod-b": toggleMark(editorSchema.marks.strong),
      "Mod-i": toggleMark(editorSchema.marks.em),
      "Mod-u": toggleMark(editorSchema.marks.underline),
      "Mod-Shift-x": toggleMark(editorSchema.marks.strikethrough),
    }),
  ],
};

const run = (view: EditorView, command: ReturnType<typeof toggleMark>) =>
  command(view.state, view.dispatch);

export const setHeading = (view: EditorView, level: 1 | 2 | 3 | 4) =>
  setBlockType(editorSchema.nodes.heading, { level })(view.state, view.dispatch);
export const setCodeBlock = (view: EditorView) =>
  setBlockType(editorSchema.nodes.code_block)(view.state, view.dispatch);
export const toggleBold = (view: EditorView) => run(view, toggleMark(editorSchema.marks.strong));
export const toggleItalic = (view: EditorView) => run(view, toggleMark(editorSchema.marks.em));
export const toggleCode = (view: EditorView) => run(view, toggleMark(editorSchema.marks.code));
export const toggleUnderline = (view: EditorView) =>
  run(view, toggleMark(editorSchema.marks.underline));
export const toggleStrikethrough = (view: EditorView) =>
  run(view, toggleMark(editorSchema.marks.strikethrough));
export const wrapQuote = (view: EditorView) =>
  wrapIn(editorSchema.nodes.blockquote)(view.state, view.dispatch);
const toggleList = (view: EditorView, listType: typeof editorSchema.nodes.bullet_list) => {
  const { $from } = view.state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type === listType) {
      return liftListItem(editorSchema.nodes.list_item)(view.state, view.dispatch);
    }
  }
  return wrapInList(listType)(view.state, view.dispatch);
};
export const wrapBulletList = (view: EditorView) =>
  toggleList(view, editorSchema.nodes.bullet_list);
export const wrapOrderedList = (view: EditorView) =>
  toggleList(view, editorSchema.nodes.ordered_list);
export const insertDivider = (view: EditorView) => {
  view.dispatch(view.state.tr.replaceSelectionWith(editorSchema.nodes.horizontal_rule.create()));
  return true;
};
