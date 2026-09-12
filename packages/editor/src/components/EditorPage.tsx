"use client";
import { Check, ChevronDown, Download } from "lucide-react";
import type { Mark } from "prosemirror-model";
import { EditorState, NodeSelection, TextSelection, Transaction } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { useCallback, useEffect, useRef, useState } from "react";

import { editorSchema } from "../core/schema";
import type { EditorDraft } from "../draft";
import { indexedDbDraftRepository } from "../draftRepository";
import type { DraftRepository } from "../draftRepository";
import type { ImageAttributes } from "../imageTypes";
import { parseMarkdown } from "../markdown/parser";
import {
  composeProseMirrorPlugins,
  defaultEditorPlugins,
  applyFontSize as applyFontSizeMark,
  applyInlineFormatting,
  applyLink as applyLinkMark,
  captureInlineFormatting,
  clearInlineFormatting,
  getLinkAtSelection,
  normalizeLink,
  redoEditor,
  removeLink as removeLinkMark,
  addEditorTableColumn,
  addEditorTableRow,
  deleteEditorTable,
  deleteEditorTableColumn,
  deleteEditorTableRow,
  undoEditor,
} from "../plugins";
import { getTheme } from "../themes";
import { renderWechatHtml } from "../wechat/renderer";

import EditorHeader from "./EditorHeader";
import EditorToolbar from "./EditorToolbar";
import { editorToolbarGroups, useEditorToolbarTools } from "./editorToolbarRegistry";
import EditorWorkspace from "./EditorWorkspace";
import ImageEditorDialog from "./ImageEditorDialog";
import ImageEditToolbar from "./ImageEditToolbar";
import LinkEditorDialog, { type LinkDraft } from "./LinkEditorDialog";
import Modal from "./Modal";
import useDocumentActions from "./useDocumentActions";
import useDraftPersistence from "./useDraftPersistence";
import useEditorDerivedState from "./useEditorDerivedState";
import useImageEditing from "./useImageEditing";
const seed = `# 产品设计的第一原则

好的产品设计，始于对用户的深刻理解。我们常常被功能、技术和商业目标牵引，却容易忽略最根本的问题：用户真正需要的是什么？

## 以用户为中心

一切设计决策，都应回归用户价值。只有真正解决用户问题，产品才能创造持续的价值。

> 设计不是把东西做得好看，而是把东西做得有用。\n> —— 戴特·拉姆斯

以用户为中心的设计，意味着：

- 深入理解用户的场景与动机
- 持续验证并迭代解决方案
- 在简洁与功能之间找到平衡

## 少即是多

克制的设计，往往更有力量。去除不必要的功能和视觉噪音，让用户专注于最重要的事情。

\`\`\`ts
function design(product) {
  while (hasUnnecessary(product)) removeUnnecessary(product)
  return product
}
\`\`\``;
type ImageUploadIntent = "insert" | "replaceDraft";
export type UploadedImage = { url: string; alt?: string };
export type EditorAction = {
  id: string;
  label: string;
  pendingLabel?: string;
  onAction: (draft: EditorDraft) => Promise<void>;
};
export type RichTextEditorProps = {
  documentId: string;
  repository?: DraftRepository;
  uploadImage?: (file: File) => Promise<UploadedImage>;
  homeHref?: string;
  brandName?: string;
  actions?: readonly EditorAction[];
};

export default function EditorPage({
  documentId,
  repository = indexedDbDraftRepository,
  uploadImage: uploadImageFile,
  homeHref = "/admin",
  brandName = "linonward notes",
  actions = [],
}: RichTextEditorProps) {
  const mount = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const imageFile = useRef<HTMLInputElement>(null);
  const fontSizeSelection = useRef<{ from: number; to: number } | null>(null);
  const documentSettingsRef = useRef({ themeId: "default", title: "产品设计的第一原则" });
  const formatBrushRef = useRef<readonly Mark[] | null>(null);
  const formatBrushSelectingRef = useRef<"keyboard" | "mouse" | null>(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [html, setHtml] = useState("");
  const [themeId, setThemeId] = useState("default");
  const [title, setTitle] = useState("产品设计的第一原则");
  const [imageUploadIntent, setImageUploadIntent] = useState<ImageUploadIntent>("insert");
  const [linkDraft, setLinkDraft] = useState<LinkDraft | null>(null);
  const [linkError, setLinkError] = useState("");
  const [saved, setSaved] = useState("正在加载");
  const [formatBrush, setFormatBrush] = useState<readonly Mark[] | null>(null);
  const [darkPreview, setDarkPreview] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const { scheduleSave, load } = useDraftPersistence({
    documentId,
    repository,
    onStatusChange: setSaved,
  });
  const [loadedDraft, setLoadedDraft] = useState<EditorDraft | null | undefined>(undefined);
  const {
    selectedImage,
    imageDraft,
    imageEditorOpen,
    uploadingImage,
    setUploadingImage,
    syncSelectedImage,
    updateDraft: updateImageDraft,
    close: closeImageEditor,
    confirm: confirmImageEdits,
    open: openImageEditor,
  } = useImageEditing(view);
  const withEditor = useCallback((operation: (editor: EditorView) => void) => {
    if (view.current) operation(view.current);
  }, []);
  const captureFontSizeSelection = useCallback(() => {
    const selection = view.current?.state.selection;
    fontSizeSelection.current = selection ? { from: selection.from, to: selection.to } : null;
  }, []);
  const chooseImage = useCallback(() => imageFile.current?.click(), []);
  const renderPreview = useCallback(
    (doc: EditorState["doc"], nextThemeId: string, immediate = false) => {
      const render = () => setHtml(renderWechatHtml(doc, getTheme(nextThemeId)));
      if (previewTimer.current) clearTimeout(previewTimer.current);
      if (immediate) render();
      else previewTimer.current = setTimeout(render, 80);
    },
    [],
  );
  const getDraft = useCallback(
    (document: EditorState["doc"]) => ({ ...documentSettingsRef.current, document }),
    [],
  );
  const { toolbar, wordCount, outlineItems, textColor, backgroundColor, syncEditorState } =
    useEditorDerivedState({
      getDraft,
      renderPreview,
      scheduleSave,
    });

  useEffect(
    () => () => {
      if (previewTimer.current) clearTimeout(previewTimer.current);
    },
    [],
  );
  useEffect(() => {
    let active = true;
    void load()
      .then((draft) => {
        if (active) setLoadedDraft(draft);
      })
      .catch(() => {
        if (active) setLoadedDraft(null);
      });
    return () => {
      active = false;
    };
  }, [load]);
  useEffect(() => {
    if (!mount.current || loadedDraft === undefined) return;
    const cached = loadedDraft;
    const doc = cached?.document ?? parseMarkdown(seed);
    if (cached) {
      documentSettingsRef.current = { themeId: cached.themeId, title: cached.title };
      setTimeout(() => {
        setTitle(cached.title);
        setThemeId(cached.themeId);
      }, 0);
    }
    const state = EditorState.create({
      doc,
      plugins: composeProseMirrorPlugins(editorSchema, defaultEditorPlugins),
    });
    const applyFormatBrush = () => {
      const brush = formatBrushRef.current;
      if (!brush || v.state.selection.from === v.state.selection.to) return;
      applyInlineFormatting(brush)(v.state, (transaction) =>
        v.updateState(v.state.apply(transaction)),
      );
      syncEditorState(v, { documentChanged: true });
      syncSelectedImage(v.state);
    };
    const v = new EditorView(mount.current, {
      state,
      dispatchTransaction(tr: Transaction) {
        v.updateState(v.state.apply(tr));
        const brush = formatBrushRef.current;
        if (
          brush &&
          tr.selectionSet &&
          !tr.docChanged &&
          !formatBrushSelectingRef.current &&
          v.state.selection.from !== v.state.selection.to
        ) {
          applyFormatBrush();
        }
        syncEditorState(v, { documentChanged: tr.docChanged });
        syncSelectedImage(v.state);
      },
    });
    const startMouseBrushSelection = () => {
      if (formatBrushRef.current) formatBrushSelectingRef.current = "mouse";
    };
    const finishMouseBrushSelection = () => {
      if (formatBrushSelectingRef.current !== "mouse") return;
      formatBrushSelectingRef.current = null;
      applyFormatBrush();
    };
    const startKeyboardBrushSelection = () => {
      if (formatBrushRef.current) formatBrushSelectingRef.current = "keyboard";
    };
    const finishKeyboardBrushSelection = () => {
      if (formatBrushSelectingRef.current !== "keyboard") return;
      formatBrushSelectingRef.current = null;
      applyFormatBrush();
    };
    v.dom.addEventListener("mousedown", startMouseBrushSelection);
    v.dom.addEventListener("keydown", startKeyboardBrushSelection);
    document.addEventListener("mouseup", finishMouseBrushSelection);
    v.dom.addEventListener("keyup", finishKeyboardBrushSelection);
    view.current = v;
    renderPreview(doc, documentSettingsRef.current.themeId, true);
    syncEditorState(v, { documentChanged: true, persist: false });
    syncSelectedImage(state);
    setSaved("已自动保存");
    return () => {
      v.dom.removeEventListener("mousedown", startMouseBrushSelection);
      v.dom.removeEventListener("keydown", startKeyboardBrushSelection);
      document.removeEventListener("mouseup", finishMouseBrushSelection);
      v.dom.removeEventListener("keyup", finishKeyboardBrushSelection);
      v.destroy();
    };
  }, [loadedDraft, renderPreview, syncEditorState, syncSelectedImage]);
  useEffect(() => {
    if (view.current) renderPreview(view.current.state.doc, themeId, true);
  }, [renderPreview, themeId]);
  useEffect(() => {
    const reposition = () => view.current && syncSelectedImage(view.current.state);
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [syncSelectedImage]);

  const changeTitle = (nextTitle: string) => {
    const settings = { ...documentSettingsRef.current, title: nextTitle };
    documentSettingsRef.current = settings;
    setTitle(nextTitle);
    if (view.current) scheduleSave({ ...settings, document: view.current.state.doc });
  };
  const changeTheme = (nextThemeId: string) => {
    const settings = { ...documentSettingsRef.current, themeId: nextThemeId };
    documentSettingsRef.current = settings;
    setThemeId(nextThemeId);
    if (view.current) scheduleSave({ ...settings, document: view.current.state.doc });
  };
  const command = (fn: (v: EditorView) => boolean) => () => view.current && fn(view.current);
  const navigateOutline = (position: number) => {
    const editor = view.current;
    if (!editor) return;
    const node = editor.nodeDOM(position);
    if (node instanceof HTMLElement) node.scrollIntoView({ behavior: "smooth", block: "center" });
    const selectionPosition = Math.min(position + 1, editor.state.doc.content.size);
    editor.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, selectionPosition)),
    );
    editor.focus();
  };
  const useFormatBrush = () => {
    if (!view.current) return;
    if (formatBrush) {
      formatBrushRef.current = null;
      setFormatBrush(null);
      return;
    }
    const captured = captureInlineFormatting(view.current.state);
    formatBrushRef.current = captured;
    setFormatBrush(captured);
  };
  const openLinkEditor = () => {
    if (!view.current) return;
    const { state } = view.current;
    const { from, to } = state.selection;
    const link = getLinkAtSelection(state);
    setLinkDraft({
      from,
      to,
      text: state.doc.textBetween(from, to),
      href: String(link?.attrs.href || ""),
    });
    setLinkError("");
  };
  const applyLink = () => {
    if (!view.current || !linkDraft) return;
    const href = normalizeLink(linkDraft.href);
    try {
      if (!href || linkDraft.from === linkDraft.to) throw new Error();
      if (/^https?:/i.test(href)) new URL(href);
      applyLinkMark(view.current, linkDraft.from, linkDraft.to, href);
      setLinkDraft(null);
    } catch {
      setLinkError(
        linkDraft.from === linkDraft.to ? "请先选择要添加链接的文本。" : "请输入有效的网址。",
      );
    }
  };
  const removeLink = () => {
    if (!view.current || !linkDraft) return;
    removeLinkMark(view.current, linkDraft.from, linkDraft.to);
    setLinkDraft(null);
  };
  const uploadImage = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selected = event.target.files?.[0];
    event.target.value = "";
    if (!selected || !view.current) return;

    setUploadingImage(true);
    try {
      if (!uploadImageFile) throw new Error("当前应用未配置图片上传。");
      const uploaded = await uploadImageFile(selected);

      const { state } = view.current;
      if (imageUploadIntent === "replaceDraft") {
        updateImageDraft({ src: uploaded.url, alt: uploaded.alt ?? selected.name });
      } else {
        view.current.dispatch(
          state.tr.replaceSelectionWith(
            editorSchema.nodes.image.create({
              src: uploaded.url,
              alt: uploaded.alt ?? selected.name,
              caption: uploaded.alt ?? selected.name,
            }),
          ),
        );
      }
    } catch (error) {
      alert(error instanceof Error ? error.message : "图片上传失败，请重试。");
    } finally {
      setUploadingImage(false);
      setImageUploadIntent("insert");
    }
  };
  const updateImage = (attrs: ImageAttributes) => {
    if (!view.current || !selectedImage) return;
    const image = view.current.state.doc.nodeAt(selectedImage.pos);
    if (!image || image.type.name !== "image") return;
    const transaction = view.current.state.tr.setNodeMarkup(selectedImage.pos, undefined, {
      ...image.attrs,
      ...attrs,
    });
    transaction.setSelection(NodeSelection.create(transaction.doc, selectedImage.pos));
    view.current.dispatch(transaction);
  };
  const deleteSelectedImage = () => {
    if (!view.current || !selectedImage) return;
    const image = view.current.state.doc.nodeAt(selectedImage.pos);
    if (!image || image.type.name !== "image") return;
    view.current.dispatch(
      view.current.state.tr.delete(selectedImage.pos, selectedImage.pos + image.nodeSize),
    );
  };
  const selectedImageWidth = () => {
    const storedSourceWidth = Number(selectedImage?.attrs.cropSourceWidth);
    if (storedSourceWidth) return storedSourceWidth;
    return selectedImage?.displayWidth || 320;
  };
  const applyFontSize = (size: string) => {
    if (!view.current) return;
    const selection = fontSizeSelection.current ?? view.current.state.selection;
    applyFontSizeMark(view.current, size, selection);
    fontSizeSelection.current = null;
  };
  const tools = useEditorToolbarTools({
    textColor,
    backgroundColor,
    uploadingImage,
    captureFontSizeSelection,
    withEditor,
    openLinkEditor,
    chooseImage,
  });
  const runAction = async (action: EditorAction) => {
    if (!view.current || pendingAction) return;
    const draft = getDraft(view.current.state.doc);
    setPendingAction(action.id);
    setSaved("正在保存");
    try {
      await repository.save(documentId, draft);
      await action.onAction(draft);
      setSaved("操作已完成");
    } catch (error) {
      setSaved(error instanceof Error ? error.message : "操作失败");
    } finally {
      setPendingAction(null);
    }
  };
  const {
    copied,
    pendingImport,
    importMarkdown,
    cancelImport,
    confirmImport,
    copyWechatHtml,
    exportMarkdown,
  } = useDocumentActions({
    view,
    themeId,
    title,
    onTitleChange: changeTitle,
    onUpdate: (editor) => syncEditorState(editor, { documentChanged: true }),
    onStateReplaced: (editor) => syncSelectedImage(editor.state),
  });
  return (
    <main className="linonward-editor editor-page min-h-screen bg-[#f8f8f6]">
      <EditorHeader
        title={title}
        themeId={themeId}
        copied={copied}
        fileInput={file}
        imageFileInput={imageFile}
        onTitleChange={changeTitle}
        onThemeChange={changeTheme}
        onImport={importMarkdown}
        onImageUpload={uploadImage}
        onCopy={copyWechatHtml}
        darkPreview={darkPreview}
        onToggleDarkPreview={() => setDarkPreview((current) => !current)}
        outlineItems={outlineItems}
        onNavigateOutline={navigateOutline}
        homeHref={homeHref}
        brandName={brandName}
        actions={actions.map((action) => ({
          id: action.id,
          label: pendingAction === action.id ? (action.pendingLabel ?? "处理中") : action.label,
          disabled: pendingAction !== null,
          onClick: () => void runAction(action),
        }))}
      />
      <EditorToolbar
        tools={tools}
        groups={editorToolbarGroups}
        toolbar={toolbar}
        command={command}
        onApplyFontSize={applyFontSize}
        formatBrush={Boolean(formatBrush)}
        onUseFormatBrush={useFormatBrush}
        undo={undoEditor}
        redo={redoEditor}
        clearFormatting={(editor) => clearInlineFormatting(editor.state, editor.dispatch)}
        addRow={addEditorTableRow}
        addColumn={addEditorTableColumn}
        deleteRow={deleteEditorTableRow}
        deleteColumn={deleteEditorTableColumn}
        deleteTable={deleteEditorTable}
      />
      {pendingImport && (
        <Modal
          title="替换当前内容？"
          description="导入 Markdown 会替换当前编辑内容。"
          onClose={cancelImport}
          className="import-confirm-modal"
          footer={
            <>
              <button type="button" onClick={cancelImport}>
                取消
              </button>
              <button type="button" className="modal-primary" onClick={confirmImport}>
                继续导入
              </button>
            </>
          }
        />
      )}
      {linkDraft && (
        <LinkEditorDialog
          draft={linkDraft}
          error={linkError}
          onChange={(href) => {
            setLinkDraft({ ...linkDraft, href });
            setLinkError("");
          }}
          onClose={() => setLinkDraft(null)}
          onSubmit={applyLink}
          onRemove={removeLink}
        />
      )}
      {selectedImage && (
        <ImageEditToolbar
          anchor={selectedImage.anchor}
          onEdit={() => openImageEditor(selectedImageWidth())}
          onDelete={deleteSelectedImage}
        />
      )}
      {selectedImage && imageEditorOpen && imageDraft && (
        <ImageEditorDialog
          image={selectedImage.attrs}
          draft={imageDraft}
          imageWidth={selectedImageWidth()}
          onChange={updateImageDraft}
          onClose={closeImageEditor}
          onConfirm={() => confirmImageEdits(updateImage)}
          onReplace={() => {
            setImageUploadIntent("replaceDraft");
            imageFile.current?.click();
          }}
        />
      )}
      <EditorWorkspace
        mount={mount}
        html={html}
        themeId={themeId}
        darkPreview={darkPreview}
        formatBrushActive={Boolean(formatBrush)}
      />
      <footer className="fixed bottom-0 h-[42px] bg-white border-t border-[#e4e5eb] inset-x-0 flex items-center px-8 text-sm text-[#717686]">
        <Check size={17} className="mr-2" />
        {saved}
        <span className="absolute left-1/2 -translate-x-1/2">字数：{wordCount}</span>
        <button
          onClick={exportMarkdown}
          className="ml-auto flex items-center gap-2 hover:text-[#4438e8]"
        >
          <Download size={16} />
          导出 Markdown
          <ChevronDown size={15} />
        </button>
      </footer>
    </main>
  );
}
