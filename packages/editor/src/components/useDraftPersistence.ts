import { useCallback, useEffect, useRef } from "react";

import type { EditorDraft } from "../draft";
import {
  DEFAULT_DOCUMENT_ID,
  indexedDbDraftRepository,
  type DraftRepository,
} from "../draftRepository";

const SAVE_DELAY_MS = 250;

export default function useDraftPersistence({
  documentId = DEFAULT_DOCUMENT_ID,
  repository = indexedDbDraftRepository,
  onStatusChange,
}: {
  documentId?: string;
  repository?: DraftRepository;
  onStatusChange: (status: string) => void;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const scheduleSave = useCallback(
    (draft: EditorDraft) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        void repository
          .save(documentId, draft)
          .then(() => onStatusChange("已自动保存"))
          .catch(() => onStatusChange("本地草稿未保存"));
      }, SAVE_DELAY_MS);
    },
    [documentId, onStatusChange, repository],
  );

  const load = useCallback(() => repository.load(documentId), [documentId, repository]);

  return { load, scheduleSave };
}
