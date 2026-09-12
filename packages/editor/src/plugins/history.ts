import { history, redo, undo } from "prosemirror-history";
import { keymap } from "prosemirror-keymap";
import type { EditorView } from "prosemirror-view";

import type { EditorPlugin } from "./types";

export const historyPlugin: EditorPlugin = {
  id: "history",
  createProseMirrorPlugins: () => [history(), keymap({ "Mod-z": undo, "Mod-Shift-z": redo })],
};

export const undoEditor = (view: EditorView) => undo(view.state, view.dispatch);
export const redoEditor = (view: EditorView) => redo(view.state, view.dispatch);
