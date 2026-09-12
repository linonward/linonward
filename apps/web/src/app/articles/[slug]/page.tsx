import { getTheme, parseDraft, renderWechatHtml, sanitizeWechatHtml } from "@linonward/editor";
import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { SiteHeader } from "@/components/site-header";
import { getPublishedArticle } from "@/server/articles";

export const dynamic = "force-dynamic";

type ArticlePageProps = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: ArticlePageProps): Promise<Metadata> {
  const { slug } = await params;
  const article = await getPublishedArticle(slug);
  return article ? { title: article.title, description: article.summary } : {};
}

export default async function ArticlePage({ params }: ArticlePageProps) {
  const { slug } = await params;
  const article = await getPublishedArticle(slug);
  if (!article) notFound();
  const draft = parseDraft({
    version: 3,
    title: article.title,
    themeId: article.themeId,
    document: article.content as Record<string, unknown>,
  });
  if (!draft) notFound();
  const html = sanitizeWechatHtml(renderWechatHtml(draft.document, getTheme(article.themeId)));
  return (
    <>
      <SiteHeader />
      <main className="bg-white">
        <article className="mx-auto w-[min(880px,calc(100%_-_40px))] py-20 sm:py-28">
          <header className="mx-auto mb-16 max-w-[720px] border-b border-[#0c2030]/20 pb-10">
            <p className="mb-5 text-xs font-bold tracking-[0.24em] text-[#d95f12]">
              LINONWARD NOTES
            </p>
            <h1 className="text-[clamp(42px,7vw,72px)] leading-[1.08] font-extrabold tracking-[-0.055em]">
              {article.title}
            </h1>
            {article.summary && (
              <p className="mt-6 text-lg leading-8 text-[#526873]">{article.summary}</p>
            )}
          </header>
          <div className="article-content" dangerouslySetInnerHTML={{ __html: html }} />
        </article>
      </main>
    </>
  );
}
