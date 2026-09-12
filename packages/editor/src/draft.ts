import type { Node as PMNode } from "prosemirror-model";

import { sanitizeEditorDocument } from "./contentSafety";
import { editorSchema } from "./core/schema";
import { themes } from "./themes";

export const DRAFT_KEY = "linonward-editor-draft";
export const LEGACY_DRAFT_KEY = "mopai-draft";
export const DRAFT_VERSION = 3;

export type EditorDraft = {
  title: string;
  themeId: string;
  document: PMNode;
};

export type EditorDraftValue = {
  version: typeof DRAFT_VERSION;
  title: string;
  themeId: string;
  document: Record<string, unknown>;
};

type DraftNode = Record<string, unknown>;

const isDraftNode = (value: unknown): value is DraftNode =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const migrateInlineImages = (value: unknown): unknown[] => {
  if (!isDraftNode(value)) return [value];
  const content = Array.isArray(value.content) ? value.content.flatMap(migrateInlineImages) : null;
  const node = content ? { ...value, content } : value;

  if (
    node.type !== "paragraph" ||
    !content?.some((child) => isDraftNode(child) && child.type === "image")
  )
    return [node];

  const blocks: unknown[] = [];
  let paragraphContent: unknown[] = [];
  const flushParagraph = () => {
    if (paragraphContent.length) {
      blocks.push({ ...node, content: paragraphContent });
      paragraphContent = [];
    }
  };

  for (const child of content) {
    if (isDraftNode(child) && child.type === "image") {
      flushParagraph();
      blocks.push(child);
    } else {
      paragraphContent.push(child);
    }
  }
  flushParagraph();
  return blocks;
};

export const loadDraft = (raw: string | null): EditorDraft | null => {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const draft = value as Record<string, unknown>;
    // Versions 0 and 1 stored images inside paragraphs. Lift them into block nodes before parsing.
    if (
      (draft.version !== undefined &&
        draft.version !== 1 &&
        draft.version !== 2 &&
        draft.version !== DRAFT_VERSION) ||
      typeof draft.title !== "string"
    )
      return null;
    if (typeof draft.themeId !== "string" || !themes.some((theme) => theme.id === draft.themeId))
      return null;
    return {
      title: draft.title,
      themeId: draft.themeId,
      document: sanitizeEditorDocument(
        editorSchema.nodeFromJSON(migrateInlineImages(draft.document)[0]),
      ),
    };
  } catch {
    return null;
  }
};

export const serializeDraft = ({ title, themeId, document }: EditorDraft) =>
  JSON.stringify({ version: DRAFT_VERSION, title, themeId, document: document.toJSON() });

export const serializeDraftValue = ({
  title,
  themeId,
  document,
}: EditorDraft): EditorDraftValue => ({
  version: DRAFT_VERSION,
  title,
  themeId,
  document: document.toJSON() as Record<string, unknown>,
});

export const parseDraft = (value: EditorDraftValue): EditorDraft | null =>
  loadDraft(JSON.stringify(value));
