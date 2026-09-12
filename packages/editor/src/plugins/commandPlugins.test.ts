import { EditorState, TextSelection } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { describe, expect, it } from "vitest";

import { editorSchema } from "../core/schema";

import {
  insertDivider,
  setCodeBlock,
  setHeading,
  toggleBold,
  toggleCode,
  toggleItalic,
  toggleStrikethrough,
  toggleUnderline,
  wrapBulletList,
  wrapOrderedList,
  wrapQuote,
} from "./formatting";
import { historyPlugin, redoEditor, undoEditor } from "./history";
import { applyLink, getLinkAtSelection, normalizeLink, removeLink } from "./link";
import { applyFontSize, applyTextStyle } from "./textStyle";

const createView = (initial: EditorState) => {
  let state = initial;
  const view = {
    get state() {
      return state;
    },
    dispatch(transaction: ReturnType<EditorState["tr"]["setSelection"]>) {
      state = state.apply(transaction);
    },
  } as unknown as EditorView;
  return { view, getState: () => state };
};

const textState = (text = "内容") => {
  const paragraph = editorSchema.nodes.paragraph.create(null, editorSchema.text(text));
  const doc = editorSchema.nodes.doc.create(null, [paragraph]);
  return EditorState.create({ doc, selection: TextSelection.create(doc, 1, text.length + 1) });
};

describe("command plugins", () => {
  it("applies independent formatting commands", () => {
    const heading = createView(textState("标题"));
    expect(setHeading(heading.view, 2)).toBe(true);
    expect(heading.getState().doc.firstChild?.type.name).toBe("heading");

    const codeBlock = createView(textState());
    expect(setCodeBlock(codeBlock.view)).toBe(true);
    expect(codeBlock.getState().doc.firstChild?.type.name).toBe("code_block");

    for (const command of [
      toggleBold,
      toggleItalic,
      toggleCode,
      toggleUnderline,
      toggleStrikethrough,
    ]) {
      const formatted = createView(textState());
      expect(command(formatted.view)).toBe(true);
      expect(formatted.getState().doc.firstChild?.firstChild?.marks).toHaveLength(1);
    }

    for (const command of [wrapQuote, wrapBulletList, wrapOrderedList]) {
      const wrapped = createView(textState());
      expect(command(wrapped.view)).toBe(true);
      expect(wrapped.getState().doc.firstChild?.type.name).not.toBe("paragraph");
    }

    const divider = createView(textState());
    expect(insertDivider(divider.view)).toBe(true);
    expect(divider.getState().doc.firstChild?.type.name).toBe("horizontal_rule");
  });

  it("adds and removes text styles", () => {
    const styled = createView(textState());
    applyTextStyle(styled.view, "text_color", "#112233");
    applyTextStyle(styled.view, "background_color", "#ffeeaa");
    applyFontSize(styled.view, "20px", styled.getState().selection);
    expect(
      styled.getState().doc.firstChild?.firstChild?.marks.map((mark) => mark.type.name),
    ).toEqual(["text_color", "background_color", "font_size"]);
  });

  it("normalizes, reads, updates, and removes selected links", () => {
    const linked = createView(textState("链接"));
    expect(normalizeLink("example.com")).toBe("https://example.com");
    expect(normalizeLink("mailto:hi@example.com")).toBe("mailto:hi@example.com");
    expect(normalizeLink(" ")).toBe("");

    applyLink(linked.view, 1, 3, "https://example.com");
    expect(getLinkAtSelection(linked.getState())?.attrs.href).toBe("https://example.com");
    removeLink(linked.view, 1, 3);
    expect(getLinkAtSelection(linked.getState())).toBeUndefined();
  });

  it("exposes undo and redo through the history plugin", () => {
    const initial = textState("初始");
    const historyState = EditorState.create({
      doc: initial.doc,
      selection: initial.selection,
      plugins: historyPlugin.createProseMirrorPlugins?.(editorSchema),
    });
    const editor = createView(historyState);
    editor.view.dispatch(editor.getState().tr.insertText("更新"));
    expect(undoEditor(editor.view)).toBe(true);
    expect(editor.getState().doc.textContent).toBe("初始");
    expect(redoEditor(editor.view)).toBe(true);
    expect(editor.getState().doc.textContent).toContain("更新");
  });
});
