import type { Command } from "prosemirror-state";
import { TextSelection } from "prosemirror-state";
import {
  addColumnAfter,
  addRowAfter,
  columnResizing,
  deleteColumn,
  deleteRow,
  deleteTable,
  tableEditing,
} from "prosemirror-tables";
import type { EditorView } from "prosemirror-view";

import { editorSchema } from "../core/schema";
import type { EditorPlugin } from "./types";

export const tablePlugin: EditorPlugin = {
  id: "table",
  createProseMirrorPlugins: () => [columnResizing(), tableEditing()],
};

const run = (view: EditorView, command: Command) => command(view.state, view.dispatch);

export const insertEditorTable = (view: EditorView) => {
  const { selection } = view.state;
  const paragraph = editorSchema.nodes.paragraph.create();
  const row = (cellType: "table_cell" | "table_header") =>
    editorSchema.nodes.table_row.create(
      null,
      Array.from({ length: 3 }, () => editorSchema.nodes[cellType].create(null, paragraph)),
    );
  const table = editorSchema.nodes.table.create(null, [
    row("table_header"),
    row("table_cell"),
    row("table_cell"),
  ]);
  const transaction = view.state.tr.replaceSelectionWith(table);
  transaction.setSelection(TextSelection.create(transaction.doc, selection.from + 4));
  view.dispatch(transaction.scrollIntoView());
  return true;
};
export const addEditorTableRow = (view: EditorView) => run(view, addRowAfter);
export const addEditorTableColumn = (view: EditorView) => run(view, addColumnAfter);
export const deleteEditorTableRow = (view: EditorView) => run(view, deleteRow);
export const deleteEditorTableColumn = (view: EditorView) => run(view, deleteColumn);
export const deleteEditorTable = (view: EditorView) => run(view, deleteTable);
