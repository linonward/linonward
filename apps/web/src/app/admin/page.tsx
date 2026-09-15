import { listArticles } from "@linonward/content";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { AdminHeader } from "@/components/admin-header";
import { NewArticleButton } from "@/components/new-article-button";

export default async function AdminPage() {
  const articles = await listArticles();
  return (
    <>
      <AdminHeader />
      <main className="mx-auto w-[min(1120px,calc(100%_-_40px))] py-16">
        <div className="mb-12 flex items-end justify-between">
          <div>
            <p className="text-xs font-bold tracking-[0.22em] text-[#d95f12]">CONTENT</p>
            <h1 className="mt-3 text-4xl font-extrabold tracking-[-0.05em]">文章</h1>
          </div>
          <NewArticleButton />
        </div>
        <div className="border-t border-[#0c2030]">
          {articles.length ? (
            articles.map((article) => (
              <Link
                className="grid grid-cols-[1fr_auto] items-center gap-6 border-b border-[#0c2030]/20 py-6 no-underline"
                href={`/admin/editor/${article.id}`}
                key={article.id}
              >
                <div>
                  <h2 className="text-xl font-bold">{article.title}</h2>
                  <p className="mt-2 text-sm text-[#62727b]">
                    {article.status === "published"
                      ? article.publishedVersion === article.version
                        ? "已发布"
                        : "有未发布更改"
                      : "草稿"}{" "}
                    · 版本 {article.version} · {article.updatedAt.toLocaleString("zh-CN")}
                  </p>
                </div>
                <ArrowRight className="size-5" aria-hidden="true" />
              </Link>
            ))
          ) : (
            <div className="py-20 text-center text-[#62727b]">还没有文章，从第一篇开始。</div>
          )}
        </div>
      </main>
    </>
  );
}
