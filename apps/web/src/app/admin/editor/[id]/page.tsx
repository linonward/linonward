import { notFound } from "next/navigation";

import { ArticleEditor } from "@/components/article-editor";
import { getArticle } from "@/server/articles";

export default async function EditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!(await getArticle(id))) notFound();
  return <ArticleEditor articleId={id} />;
}
