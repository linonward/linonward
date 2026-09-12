import { publishArticle } from "@/server/articles";
import { isAdministrator } from "@/server/auth";

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  if (!(await isAdministrator())) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await context.params;
  const article = await publishArticle(id);
  if (!article) return Response.json({ error: "Not found" }, { status: 404 });
  return Response.json({ status: article.status, publishedAt: article.publishedAt });
}
