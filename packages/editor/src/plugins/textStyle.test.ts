import { EditorState, TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { describe, expect, it } from "vitest";

import { editorSchema } from "../core/schema";

import { toggleMarker } from "./marker";
import {
  applyInlineFormatting,
  captureInlineFormatting,
  clearInlineFormatting,
  selectedTextStyleColor,
} from "./textStyle";

const stateFor = (
  text: string,
  marks: ReturnType<typeof editorSchema.marks.strong.create>[] = [],
) => {
  const paragraph = editorSchema.nodes.paragraph.create(null, editorSchema.text(text, marks));
  const doc = editorSchema.nodes.doc.create(null, [paragraph]);
  return EditorState.create({ doc, selection: TextSelection.create(doc, 1, text.length + 1) });
};

describe("inline formatting commands", () => {
  it("captures formatting and paints it onto selected text", () => {
    const source = stateFor("源文本", [editorSchema.marks.strong.create()]);
    const marks = captureInlineFormatting(source);
    const target = stateFor("目标文本");
    let painted = target;

    expect(
      applyInlineFormatting(marks)(target, (transaction) => (painted = target.apply(transaction))),
    ).toBe(true);
    expect(painted.doc.firstChild?.firstChild?.marks).toEqual(marks);
  });

  it("clears all selected inline marks without changing the text", () => {
    const state = stateFor("格式文本", [
      editorSchema.marks.strong.create(),
      editorSchema.marks.text_color.create({ color: "#4438e8" }),
    ]);
    let cleared = state;

    expect(
      clearInlineFormatting(state, (transaction) => (cleared = state.apply(transaction))),
    ).toBe(true);
    expect(cleared.doc.textContent).toBe("格式文本");
    expect(cleared.doc.firstChild?.firstChild?.marks).toEqual([]);
  });

  it("clears stored marks at a collapsed cursor and does not paint without a range", () => {
    const state = stateFor("格式文本");
    const cursor = state.apply(
      state.tr
        .setSelection(TextSelection.create(state.doc, 1))
        .setStoredMarks([editorSchema.marks.strong.create()]),
    );
    let cleared = cursor;

    expect(captureInlineFormatting(cursor)).toHaveLength(1);
    expect(
      clearInlineFormatting(cursor, (transaction) => (cleared = cursor.apply(transaction))),
    ).toBe(true);
    expect(captureInlineFormatting(cleared)).toEqual([]);
    expect(applyInlineFormatting([])(cleared, () => undefined)).toBe(false);
  });

  it("reads a uniform selected text color and falls back for mixed colors", () => {
    const color = editorSchema.marks.text_color.create({ color: "#123456" });
    const uniform = stateFor("颜色", [color]);
    expect(selectedTextStyleColor(uniform, "text_color", "#4438e8")).toBe("#123456");

    const mixedDoc = editorSchema.nodes.doc.create(null, [
      editorSchema.nodes.paragraph.create(null, [
        editorSchema.text("无色"),
        editorSchema.text("有色", [color]),
      ]),
    ]);
    const mixed = EditorState.create({
      doc: mixedDoc,
      selection: TextSelection.create(mixedDoc, 1, mixedDoc.content.size - 1),
    });
    expect(selectedTextStyleColor(mixed, "text_color", "#4438e8")).toBe("#4438e8");
  });

  it("toggles the marker mark on selected text", () => {
    let marked = stateFor("重点文本");
    const view = {
      get state() {
        return marked;
      },
      dispatch(transaction: Parameters<EditorView["dispatch"]>[0]) {
        marked = marked.apply(transaction);
      },
    } as EditorView;

    expect(toggleMarker(view)).toBe(true);
    expect(marked.doc.firstChild?.firstChild?.marks.map((mark) => mark.type.name)).toEqual([
      "marker",
    ]);
    expect(toggleMarker(view)).toBe(true);
    expect(marked.doc.firstChild?.firstChild?.marks).toEqual([]);
  });
});
