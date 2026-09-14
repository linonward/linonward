import Link from "next/link";
import type { ReactNode } from "react";

import { chapters, getChapterNeighbors, type Chapter } from "@/lib/chapters";

import { ArrowIcon, BookIcon, MenuIcon } from "./icons";

interface TutorialShellProps {
  chapter: Chapter;
  children: ReactNode;
}

function ChapterLinks({ activeSlug }: { activeSlug: string }) {
  return (
    <nav aria-label="教程章节">
      {chapters.map((item) => (
        <Link
          aria-current={item.slug === activeSlug ? "page" : undefined}
          className="chapter-link"
          href={`/${item.slug}`}
          key={item.slug}
        >
          <span>{item.number}</span>
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

export function TutorialShell({ chapter, children }: TutorialShellProps) {
  const chapterIndex = chapters.findIndex((item) => item.slug === chapter.slug);
  const progress = ((chapterIndex + 1) / chapters.length) * 100;
  const { previous, next } = getChapterNeighbors(chapter.slug);

  return (
    <div className="tutorial-shell">
      <header className="tutorial-header">
        <details className="mobile-menu">
          <summary aria-label="打开章节导航">
            <MenuIcon />
          </summary>
          <div className="mobile-menu__panel">
            <ChapterLinks activeSlug={chapter.slug} />
          </div>
        </details>

        <Link className="tutorial-brand" href="/start">
          <BookIcon />
          <span className="tutorial-brand__desktop">
            LinOnward <span>/ Agent Tutorial</span>
          </span>
          <span className="tutorial-brand__mobile">Agent Tutorial</span>
        </Link>

        <div
          aria-label={`阅读进度：第 ${chapterIndex + 1} 章，共 ${chapters.length} 章`}
          className="reading-progress"
        >
          <div className="reading-progress__label">
            <span>
              {chapterIndex + 1} / {chapters.length}
            </span>
            <span>{Math.round(progress)}%</span>
          </div>
          <div className="reading-progress__track">
            <span style={{ width: `${progress}%` }} />
          </div>
        </div>
      </header>

      <aside className="chapter-sidebar">
        <ChapterLinks activeSlug={chapter.slug} />
      </aside>

      <main className="tutorial-main">
        <article className="tutorial-article">
          <header className="article-header">
            <span className="article-number">{chapter.number}</span>
            <h1>{chapter.title}</h1>
            <p>{chapter.description}</p>
          </header>

          <div className="mdx-content">{children}</div>

          <nav aria-label="章节翻页" className="chapter-pager">
            {previous ? (
              <Link
                className="chapter-pager__link chapter-pager__link--previous"
                href={`/${previous.slug}`}
              >
                <ArrowIcon />
                <span>
                  <small>上一章</small>
                  {previous.label}
                </span>
              </Link>
            ) : (
              <span />
            )}
            {next ? (
              <Link
                className="chapter-pager__link chapter-pager__link--next"
                href={`/${next.slug}`}
              >
                <span>
                  <small>下一章</small>
                  {next.label}
                </span>
                <ArrowIcon />
              </Link>
            ) : (
              <span />
            )}
          </nav>
        </article>
      </main>

      <aside className="toc-sidebar">
        <strong>本页目录</strong>
        <nav aria-label="本页目录">
          {chapter.toc.map((item) => (
            <a href={`#${item.id}`} key={item.id}>
              {item.title}
            </a>
          ))}
        </nav>
      </aside>
    </div>
  );
}
