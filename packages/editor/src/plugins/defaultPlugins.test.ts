import { EditorState, TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { describe, expect, it } from "vitest";

import { editorSchema } from "../core/schema";

import { defaultEditorPlugins } from "./defaultPlugins";
import { inputRulesPlugin } from "./inputRules";
import { currentTextAlign, setTextAlign } from "./textAlign";
import { composeProseMirrorPlugins } from "./types";

describe("default editor plugins", () => {
  it("registers independently composable ProseMirror behavior", () => {
    expect(defaultEditorPlugins.map((plugin) => plugin.id)).toEqual([
      "history",
      "input-rules",
      "base-keymap",
      "formatting",
      "text-style",
      "marker",
      "link",
      "text-align",
      "table",
      "clipboard",
    ]);
    expect(composeProseMirrorPlugins(editorSchema, defaultEditorPlugins)).toHaveLength(8);
  });

  it("applies alignment to selected text blocks", () => {
    const paragraph = editorSchema.nodes.paragraph.create(null, editorSchema.text("内容"));
    const doc = editorSchema.nodes.doc.create(null, [paragraph]);
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, 1, 3) });
    let next = state;
    expect(setTextAlign("center")(state, (transaction) => (next = state.apply(transaction)))).toBe(
      true,
    );
    expect(next.doc.firstChild?.attrs.textAlign).toBe("center");
    expect(currentTextAlign(next)).toBe("center");
    expect(setTextAlign("center")(next, () => undefined)).toBe(false);

    const heading = editorSchema.nodes.heading.create({ level: 2 }, editorSchema.text("标题"));
    const headingDoc = editorSchema.nodes.doc.create(null, [heading]);
    const headingState = EditorState.create({
      doc: headingDoc,
      selection: TextSelection.create(headingDoc, 1),
    });
    let alignedHeading = headingState;
    setTextAlign("right")(
      headingState,
      (transaction) => (alignedHeading = headingState.apply(transaction)),
    );
    expect(alignedHeading.doc.firstChild?.attrs.textAlign).toBe("right");
  });

  it("turns Markdown heading syntax into a heading after its trailing space", () => {
    const paragraph = editorSchema.nodes.paragraph.create(null, editorSchema.text("##"));
    const doc = editorSchema.nodes.doc.create(null, [paragraph]);
    let state = EditorState.create({ doc, selection: TextSelection.create(doc, 3) });
    const view = {
      get state() {
        return state;
      },
      dispatch(transaction: Parameters<EditorView["dispatch"]>[0]) {
        state = state.apply(transaction);
      },
    } as EditorView;
    const inputRulePlugin = inputRulesPlugin.createProseMirrorPlugins?.(editorSchema)[0];

    expect(
      inputRulePlugin?.props.handleTextInput?.call(inputRulePlugin, view, 3, 3, " ", () =>
        state.tr.insertText(" ", 3, 3),
      ),
    ).toBe(true);
    expect(state.doc.firstChild?.type).toBe(editorSchema.nodes.heading);
    expect(state.doc.firstChild?.attrs.level).toBe(2);
  });
});
