import type { EditorState } from "prosemirror-state";
import { isInTable } from "prosemirror-tables";

import { editorSchema } from "./core/schema";
import { currentTextAlign } from "./plugins";

export type ToolbarState = Record<string, boolean>;

export const getToolbarState = (state: EditorState): ToolbarState => {
  const { from, to, $from } = state.selection;
  const mark = (name: keyof typeof editorSchema.marks) => {
    const markType = editorSchema.marks[name];
    return from === to
      ? (state.storedMarks || $from.marks()).some((entry) => entry.type === markType)
      : state.doc.rangeHasMark(from, to, markType);
  };
  const block = (name: string, level?: number) => {
    for (let depth = $from.depth; depth > 0; depth--) {
      const node = $from.node(depth);
      if (node.type.name === name && (!level || node.attrs.level === level)) return true;
    }
    return false;
  };

  return {
    bold: mark("strong"),
    italic: mark("em"),
    underline: mark("underline"),
    strikethrough: mark("strikethrough"),
    code: mark("code"),
    marker: mark("marker"),
    h2: block("heading", 2),
    h3: block("heading", 3),
    h4: block("heading", 4),
    quote: block("blockquote"),
    bullet: block("bullet_list"),
    ordered: block("ordered_list"),
    codeBlock: block("code_block"),
    link: mark("link"),
    alignLeft: currentTextAlign(state) === "left",
    alignCenter: currentTextAlign(state) === "center",
    alignRight: currentTextAlign(state) === "right",
    alignJustify: currentTextAlign(state) === "justify",
    table: isInTable(state),
  };
};
