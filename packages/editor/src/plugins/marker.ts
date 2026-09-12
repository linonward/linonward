import { toggleMark } from "prosemirror-commands";
import type { EditorView } from "prosemirror-view";

import { editorSchema } from "../core/schema";

import type { EditorPlugin } from "./types";

/** A fixed yellow highlight for emphasizing important passages. */
export const markerPlugin: EditorPlugin = { id: "marker" };

export const toggleMarker = (view: EditorView) =>
  toggleMark(editorSchema.marks.marker)(view.state, view.dispatch);
