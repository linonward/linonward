"use client";

import {
  parseDraft,
  RichTextEditor,
  serializeDraftValue,
  type DocumentSummary,
  type DraftRepository,
  type EditorDraft,
  type EditorDraftValue,
} from "@linonward/editor";
import { useMemo } from "react";

const responseError = async (response: Response, fallback: string) => {
  const payload = (await response.json().catch(() => null)) as { error?: string } | null;
  return new Error(payload?.error || fallback);
};

export function ArticleEditor({ articleId }: { articleId: string }) {
  const repository = useMemo<DraftRepository>(
    () => ({
      async load(documentId) {
        const response = await fetch(`/api/admin/articles/${documentId}`, { cache: "no-store" });
        if (!response.ok) throw await responseError(response, "无法加载文章。");
        const payload = (await response.json()) as { draft: EditorDraftValue };
        return parseDraft(payload.draft);
      },
      async save(documentId, draft: EditorDraft) {
        const response = await fetch(`/api/admin/articles/${documentId}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(serializeDraftValue(draft)),
        });
        if (!response.ok) throw await responseError(response, "无法保存文章。");
      },
      async list(): Promise<DocumentSummary[]> {
        const response = await fetch("/api/admin/articles", { cache: "no-store" });
        if (!response.ok) throw await responseError(response, "无法加载文章列表。");
        const payload = (await response.json()) as {
          articles: { id: string; title: string; updatedAt: string }[];
        };
        return payload.articles.map((article) => ({
          id: article.id,
          title: article.title,
          updatedAt: new Date(article.updatedAt).getTime(),
        }));
      },
    }),
    [],
  );

  return (
    <RichTextEditor
      actions={[
        {
          id: "publish",
          label: "发布网站",
          pendingLabel: "发布中",
          onAction: async () => {
            const response = await fetch(`/api/admin/articles/${articleId}/publish`, {
              method: "POST",
            });
            if (!response.ok) throw await responseError(response, "网站发布失败。");
          },
        },
        {
          id: "wechat",
          label: "同步微信草稿",
          pendingLabel: "同步中",
          onAction: async () => {
            const response = await fetch(`/api/admin/articles/${articleId}/wechat`, {
              method: "POST",
            });
            if (!response.ok) throw await responseError(response, "公众号草稿同步失败。");
          },
        },
      ]}
      documentId={articleId}
      repository={repository}
      homeHref="/admin"
      brandName="linonward notes"
      uploadImage={async (file) => {
        const signature = await fetch("/api/admin/uploads", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ contentType: file.type, size: file.size }),
        });
        if (!signature.ok) throw await responseError(signature, "无法创建上传地址。");
        const payload = (await signature.json()) as { uploadUrl: string; publicUrl: string };
        const upload = await fetch(payload.uploadUrl, {
          method: "PUT",
          headers: { "content-type": file.type },
          body: file,
        });
        if (!upload.ok) throw new Error("图片上传失败。");
        return { url: payload.publicUrl, alt: file.name };
      }}
    />
  );
}
