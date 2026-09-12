import { baseKeymap, chainCommands } from "prosemirror-commands";
import { keymap } from "prosemirror-keymap";
import { liftListItem, sinkListItem, splitListItem } from "prosemirror-schema-list";

import { editorSchema } from "../core/schema";

import type { EditorPlugin } from "./types";

const listItem = editorSchema.nodes.list_item;

export const baseKeymapPlugin: EditorPlugin = {
  id: "base-keymap",
  createProseMirrorPlugins: () => [
    keymap({
      ...baseKeymap,
      Enter: chainCommands(splitListItem(listItem), baseKeymap.Enter!),
      Tab: sinkListItem(listItem),
      "Shift-Tab": liftListItem(listItem),
    }),
  ],
};
