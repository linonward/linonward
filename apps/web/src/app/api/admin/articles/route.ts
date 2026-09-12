import { createArticle, listArticles } from "@/server/articles";
import { isAdministrator } from "@/server/auth";

export async function GET() {
  if (!(await isAdministrator())) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json({ articles: await listArticles() });
}

export async function POST() {
  if (!(await isAdministrator())) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return Response.json({ article: await createArticle() }, { status: 201 });
}
