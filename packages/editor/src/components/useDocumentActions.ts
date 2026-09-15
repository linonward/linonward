import { EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { ChangeEvent, RefObject } from "react";
import { useState } from "react";

import { parseMarkdown, serializeMarkdown } from "../markdown/parser";
import { getTheme } from "../themes";
import { renderWechatHtml } from "../wechat/renderer";
import { sanitizeWechatHtml } from "../wechat/sanitizer";

export default function useDocumentActions({
  view,
  themeId,
  title,
  onTitleChange,
  onUpdate,
  onStateReplaced,
}: {
  view: RefObject<EditorView | null>;
  themeId: string;
  title: string;
  onTitleChange: (title: string) => void;
  onUpdate: (view: EditorView) => void;
  onStateReplaced: (view: EditorView) => void;
}) {
  const [copied, setCopied] = useState(false);
  const [pendingImport, setPendingImport] = useState<File | null>(null);
  const applyImport = async (file: File) => {
    if (!view.current) return;
    const doc = parseMarkdown(await file.text());
    view.current.updateState(EditorState.create({ doc, plugins: view.current.state.plugins }));
    onUpdate(view.current);
    onStateReplaced(view.current);
    onTitleChange(file.name.replace(/\.(md|markdown)$/i, ""));
  };
  const importMarkdown = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !view.current) return;
    event.target.value = "";
    if (view.current.state.doc.textContent) {
      setPendingImport(file);
      return;
    }
    await applyImport(file);
  };
  const copyWechatHtml = async () => {
    if (!view.current) return;
    const html = sanitizeWechatHtml(renderWechatHtml(view.current.state.doc, getTheme(themeId)));
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([view.current.state.doc.textContent], { type: "text/plain" }),
        }),
      ]);
    } catch {
      await navigator.clipboard.writeText(html);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };
  const exportMarkdown = () => {
    if (!view.current) return;
    const link = document.createElement("a");
    link.href = URL.createObjectURL(
      new Blob([serializeMarkdown(view.current.state.doc)], { type: "text/markdown" }),
    );
    link.download = `${title || "article"}.md`;
    link.click();
    URL.revokeObjectURL(link.href);
  };
  return {
    copied,
    pendingImport,
    importMarkdown,
    cancelImport: () => setPendingImport(null),
    confirmImport: async () => {
      if (!pendingImport) return;
      const file = pendingImport;
      setPendingImport(null);
      await applyImport(file);
    },
    copyWechatHtml,
    exportMarkdown,
  };
}
