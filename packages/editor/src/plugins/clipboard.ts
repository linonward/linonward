import { DOMParser, DOMSerializer } from "prosemirror-model";
import { Plugin } from "prosemirror-state";

import type { EditorPlugin } from "./types";

// Explicitly bind the editor schema to the browser's native copy/paste flow.
// This preserves rich content (including tables) for Cmd/Ctrl+C and Cmd/Ctrl+V
// without adding another editor control.
export const clipboardPlugin: EditorPlugin = {
  id: "clipboard",
  createProseMirrorPlugins: (schema) => [
    new Plugin({
      props: {
        clipboardParser: DOMParser.fromSchema(schema),
        clipboardSerializer: DOMSerializer.fromSchema(schema),
      },
    }),
  ],
};
