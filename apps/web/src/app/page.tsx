import { ArrowUpRight } from "lucide-react";
import Link from "next/link";

import { SiteHeader } from "@/components/site-header";
import { listPublishedArticles } from "@/server/articles";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const articles = await listPublishedArticles();
  return (
    <>
      <SiteHeader />
      <main>
        <section className="mx-auto w-[min(1120px,calc(100%_-_40px))] py-24 sm:py-32">
          <h1 className="max-w-[8ch] text-[clamp(58px,10vw,112px)] leading-[0.96] font-extrabold tracking-[-0.065em]">
            把日常，走成风景。
          </h1>
          <p className="mt-8 max-w-xl text-lg leading-8 text-[#425865]">
            关于成长、行动与发现的长期记录。写下真实的过程，也为下一步留下线索。
          </p>
        </section>
        <section className="border-t border-[#0c2030]/15 bg-white">
          <div className="mx-auto w-[min(1120px,calc(100%_-_40px))] py-20">
            <div className="mb-12 flex items-end justify-between border-b border-[#0c2030] pb-5">
              <h2 className="text-3xl font-bold tracking-[-0.04em]">最近文章</h2>
              <span className="text-sm text-[#62727b]">{articles.length} 篇</span>
            </div>
            {articles.length ? (
              <div>
                {articles.map((article) => (
                  <Link
                    className="group grid gap-5 border-b border-[#0c2030]/20 py-8 no-underline sm:grid-cols-[1fr_auto]"
                    href={`/articles/${article.slug}`}
                    key={article.id}
                  >
                    <div>
                      <h3 className="text-2xl font-bold tracking-[-0.035em] group-hover:text-[#d95f12]">
                        {article.title}
                      </h3>
                      {article.summary && (
                        <p className="mt-3 max-w-2xl text-[#526873]">{article.summary}</p>
                      )}
                    </div>
                    <ArrowUpRight className="mt-1 size-5" aria-hidden="true" />
                  </Link>
                ))}
              </div>
            ) : (
              <p className="py-14 text-lg text-[#62727b]">第一篇文章正在路上。</p>
            )}
          </div>
        </section>
      </main>
    </>
  );
}
