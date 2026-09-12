import type { EditorView } from "prosemirror-view";
import { useCallback, useState } from "react";

import type { EditorDraft } from "../draft";
import { getToolbarState, type ToolbarState } from "../editorState";
import { getOutlineItems, type OutlineItem } from "../outline";
import { selectedTextStyleColor } from "../plugins/textStyle";

type SyncOptions = { documentChanged: boolean; persist?: boolean };

export default function useEditorDerivedState({
  getDraft,
  renderPreview,
  scheduleSave,
}: {
  getDraft: (document: EditorDraft["document"]) => EditorDraft;
  renderPreview: (document: EditorDraft["document"], themeId: string, immediate?: boolean) => void;
  scheduleSave: (draft: EditorDraft) => void;
}) {
  const [toolbar, setToolbar] = useState<ToolbarState>({});
  const [wordCount, setWordCount] = useState(0);
  const [outlineItems, setOutlineItems] = useState<OutlineItem[]>([]);
  const [textColor, setTextColor] = useState("#4438e8");
  const [backgroundColor, setBackgroundColor] = useState("#fff2a8");

  const syncEditorState = useCallback(
    (view: EditorView, { documentChanged, persist = documentChanged }: SyncOptions) => {
      setToolbar(getToolbarState(view.state));
      setTextColor(selectedTextStyleColor(view.state, "text_color", "#4438e8"));
      setBackgroundColor(selectedTextStyleColor(view.state, "background_color", "#fff2a8"));
      if (!documentChanged) return;

      const draft = getDraft(view.state.doc);
      renderPreview(draft.document, draft.themeId);
      setWordCount(draft.document.textContent.length);
      setOutlineItems(getOutlineItems(draft.document));
      if (persist) scheduleSave(draft);
    },
    [getDraft, renderPreview, scheduleSave],
  );

  return { toolbar, wordCount, outlineItems, textColor, backgroundColor, syncEditorState };
}
