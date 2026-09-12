import type { EditorDraft } from "./draft";
import { DRAFT_KEY, LEGACY_DRAFT_KEY, loadDraft, serializeDraft } from "./draft";

export const DEFAULT_DOCUMENT_ID = "default";
const DATABASE_NAME = "linonward-editor-documents";
const DATABASE_VERSION = 1;
const DOCUMENT_STORE = "documents";

export type DocumentSummary = { id: string; title: string; updatedAt: number };

export type DraftRepository = {
  load(documentId: string): Promise<EditorDraft | null>;
  save(documentId: string, draft: EditorDraft): Promise<void>;
  list(): Promise<DocumentSummary[]>;
};

type StoredDocument = DocumentSummary & { draft: string };

const openDatabase = () =>
  new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DOCUMENT_STORE))
        request.result.createObjectStore(DOCUMENT_STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

const requestResult = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

/** Browser storage backed by IndexedDB. The old localStorage draft is migrated on first use. */
export const indexedDbDraftRepository: DraftRepository = {
  async load(documentId) {
    const database = await openDatabase();
    try {
      const record = await requestResult(
        database.transaction(DOCUMENT_STORE).objectStore(DOCUMENT_STORE).get(documentId),
      );
      if (record) return loadDraft((record as StoredDocument).draft);
      if (documentId !== DEFAULT_DOCUMENT_ID) return null;

      const legacyDraft = loadDraft(
        localStorage.getItem(DRAFT_KEY) ?? localStorage.getItem(LEGACY_DRAFT_KEY),
      );
      if (legacyDraft) {
        await this.save(documentId, legacyDraft);
        localStorage.removeItem(DRAFT_KEY);
        localStorage.removeItem(LEGACY_DRAFT_KEY);
      }
      return legacyDraft;
    } finally {
      database.close();
    }
  },
  async save(documentId, draft) {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(DOCUMENT_STORE, "readwrite");
      transaction.objectStore(DOCUMENT_STORE).put({
        id: documentId,
        title: draft.title,
        updatedAt: Date.now(),
        draft: serializeDraft(draft),
      } satisfies StoredDocument);
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  },
  async list() {
    const database = await openDatabase();
    try {
      const records = (await requestResult(
        database.transaction(DOCUMENT_STORE).objectStore(DOCUMENT_STORE).getAll(),
      )) as StoredDocument[];
      return records
        .map(({ id, title, updatedAt }) => ({ id, title, updatedAt }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    } finally {
      database.close();
    }
  },
};

export class MemoryDraftRepository implements DraftRepository {
  private readonly drafts = new Map<string, { draft: EditorDraft; updatedAt: number }>();

  async load(documentId: string) {
    return this.drafts.get(documentId)?.draft ?? null;
  }

  async save(documentId: string, draft: EditorDraft) {
    this.drafts.set(documentId, { draft, updatedAt: Date.now() });
  }

  async list() {
    return [...this.drafts.entries()]
      .map(([id, { draft, updatedAt }]) => ({ id, title: draft.title, updatedAt }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
}
