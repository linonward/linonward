import { parseDraft, serializeDraftValue } from "@linonward/editor";
import type { EditorDraftValue } from "@linonward/editor";

import { getArticle, saveArticle } from "@/server/articles";
import { isAdministrator } from "@/server/auth";

const isDraftValue = (value: unknown): value is EditorDraftValue => {
  if (!value || typeof value !== "object") return false;
  const draft = value as Record<string, unknown>;
  return (
    draft.version === 3 &&
    typeof draft.title === "string" &&
    draft.title.length <= 120 &&
    typeof draft.themeId === "string" &&
    Boolean(draft.document) &&
    typeof draft.document === "object"
  );
};

type ArticleRouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: ArticleRouteContext) {
  if (!(await isAdministrator())) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const article = await getArticle(id);
  if (!article) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({
    version: article.version,
    draft: {
      version: 3,
      title: article.title,
      themeId: article.themeId,
      document: article.content as Record<string, unknown>,
    } satisfies EditorDraftValue,
  });
}

export async function PUT(request: Request, context: ArticleRouteContext) {
  if (!(await isAdministrator())) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const versionHeader = request.headers.get("if-match");
  if (versionHeader === null)
    return Response.json({ error: "Article version is required" }, { status: 428 });
  if (!/^[1-9]\d*$/.test(versionHeader))
    return Response.json({ error: "Invalid article version" }, { status: 400 });
  const expectedVersion = Number(versionHeader);
  if (!Number.isSafeInteger(expectedVersion))
    return Response.json({ error: "Invalid article version" }, { status: 400 });
  const value: unknown = await request.json();
  if (!isDraftValue(value)) return Response.json({ error: "Invalid article" }, { status: 400 });
  const draft = parseDraft(value);
  if (!draft) return Response.json({ error: "Invalid article document" }, { status: 400 });
  const { id } = await context.params;
  const result = await saveArticle(id, serializeDraftValue(draft), expectedVersion);
  if (result.status === "not_found") return Response.json({ error: "Not found" }, { status: 404 });
  if (result.status === "conflict")
    return Response.json({ error: "文章已在其他窗口更新，请刷新后继续编辑。" }, { status: 409 });
  return Response.json({ version: result.article.version, updatedAt: result.article.updatedAt });
}
