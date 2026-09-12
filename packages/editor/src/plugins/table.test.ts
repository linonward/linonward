import { EditorState, TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { describe, expect, it } from "vitest";

import { editorSchema } from "../core/schema";

import {
  addEditorTableColumn,
  addEditorTableRow,
  deleteEditorTable,
  deleteEditorTableColumn,
  deleteEditorTableRow,
  insertEditorTable,
} from "./table";

const createView = () => {
  const paragraph = editorSchema.nodes.paragraph.create(null, editorSchema.text("内容"));
  let state = EditorState.create({
    doc: editorSchema.nodes.doc.create(null, [paragraph]),
    selection: TextSelection.create(editorSchema.nodes.doc.create(null, [paragraph]), 1),
  });
  return {
    get state() {
      return state;
    },
    dispatch(transaction: Parameters<EditorView["dispatch"]>[0]) {
      state = state.apply(transaction);
    },
  } as EditorView;
};

describe("table commands", () => {
  it("inserts and edits a table", () => {
    const view = createView();

    expect(insertEditorTable(view)).toBe(true);
    let table = view.state.doc.firstChild;
    expect(table?.type.name).toBe("table");
    expect(table?.childCount).toBe(3);
    expect(table?.firstChild?.childCount).toBe(3);
    expect(table?.firstChild?.firstChild?.type.name).toBe("table_header");

    expect(addEditorTableRow(view)).toBe(true);
    expect(addEditorTableColumn(view)).toBe(true);
    table = view.state.doc.firstChild;
    expect(table?.childCount).toBe(4);
    expect(table?.firstChild?.childCount).toBe(4);

    expect(deleteEditorTableRow(view)).toBe(true);
    expect(deleteEditorTableColumn(view)).toBe(true);
    table = view.state.doc.firstChild;
    expect(table?.childCount).toBe(3);
    expect(table?.firstChild?.childCount).toBe(3);

    expect(deleteEditorTable(view)).toBe(true);
    expect(view.state.doc.firstChild?.type.name).toBe("paragraph");
  });
});
