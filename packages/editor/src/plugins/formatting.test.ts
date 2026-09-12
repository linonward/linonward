import { EditorState, TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { describe, expect, it } from "vitest";

import { editorSchema } from "../core/schema";

import { wrapBulletList, wrapOrderedList } from "./formatting";

const createView = (initialState: EditorState) => {
  let state = initialState;
  return {
    get state() {
      return state;
    },
    dispatch(transaction: Parameters<EditorView["dispatch"]>[0]) {
      state = state.apply(transaction);
    },
  } as EditorView;
};

describe("list formatting", () => {
  it.each([
    ["bullet_list", wrapBulletList],
    ["ordered_list", wrapOrderedList],
  ] as const)("toggles %s on and off", (listType, toggle) => {
    const paragraph = editorSchema.nodes.paragraph.create(null, editorSchema.text("内容"));
    const doc = editorSchema.nodes.doc.create(null, [paragraph]);
    const view = createView(EditorState.create({ doc, selection: TextSelection.create(doc, 1) }));

    expect(toggle(view)).toBe(true);
    expect(view.state.doc.firstChild?.type.name).toBe(listType);
    expect(toggle(view)).toBe(true);
    expect(view.state.doc.firstChild?.type.name).toBe("paragraph");
  });
});
