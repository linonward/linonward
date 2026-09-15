import Link from "next/link";
import type { ReactNode } from "react";

import { type AnyChapter, chapters, getChapterNeighbors, tutorialGoal } from "@/lib/chapters";
import { extensionChapters, getExtensionNeighbors } from "@/lib/extensions";

import { ArrowIcon, BookIcon } from "./icons";
import { MobileNavigation } from "./mobile-navigation";

interface TutorialShellProps {
  chapter: AnyChapter;
  children: ReactNode;
}

function ChapterLink({ item, activeSlug }: { item: AnyChapter; activeSlug: string }) {
  return (
    <Link
      aria-current={item.slug === activeSlug ? "page" : undefined}
      className="chapter-link"
      href={`/${item.slug}`}
    >
      <span className="chapter-link__number">{item.number}</span>
      <span className="chapter-link__text">
        <strong>{item.label}</strong>
        <small>{item.minutes} 分钟</small>
      </span>
    </Link>
  );
}

function ChapterLinks({ activeSlug }: { activeSlug: string }) {
  return (
    <>
      <nav aria-label="教程章节">
        {chapters.map((item) => (
          <ChapterLink activeSlug={activeSlug} item={item} key={item.slug} />
        ))}
      </nav>
      <nav aria-label="扩展篇章节" className="chapter-group">
        <Link className="chapter-group__label" href="/extensions">
          <strong>扩展篇</strong>
          <small>{extensionChapters.length} 篇 · 非主线前置</small>
        </Link>
        {extensionChapters.map((item) => (
          <ChapterLink activeSlug={activeSlug} item={item} key={item.slug} />
        ))}
      </nav>
    </>
  );
}

export function TutorialShell({ chapter, children }: TutorialShellProps) {
  const isExtension = chapter.track === "extension";
  const siblings: AnyChapter[] = isExtension ? extensionChapters : chapters;
  const chapterIndex = siblings.findIndex((item) => item.slug === chapter.slug);
  const progress = ((chapterIndex + 1) / siblings.length) * 100;
  const { previous, next } = isExtension
    ? getExtensionNeighbors(chapter.slug)
    : getChapterNeighbors(chapter.slug);
  const positionLabel = isExtension
    ? `扩展篇位置：第 ${chapterIndex + 1} 篇，共 ${siblings.length} 篇`
    : `章节位置：第 ${chapterIndex + 1} 章，共 ${siblings.length} 章`;
  const showExtensionEntry = !isExtension && !next;

  return (
    <div className="tutorial-shell">
      <header className="tutorial-header">
        <MobileNavigation>
          <ChapterLinks activeSlug={chapter.slug} />
        </MobileNavigation>

        <Link className="tutorial-brand" href="/start">
          <BookIcon />
          <span className="tutorial-brand__desktop">
            LinOnward <span>/ Agent Tutorial</span>
          </span>
          <span className="tutorial-brand__mobile">Agent Tutorial</span>
        </Link>

        <div aria-label={positionLabel} className="chapter-position">
          <div className="chapter-position__label">
            <span>{isExtension ? "扩展篇" : "章节"}</span>
            <span>
              {chapterIndex + 1} / {siblings.length}
            </span>
          </div>
          <div aria-hidden="true" className="chapter-position__track">
            <span style={{ width: `${progress}%` }} />
          </div>
        </div>
      </header>

      <aside className="chapter-sidebar">
        <ChapterLinks activeSlug={chapter.slug} />
      </aside>

      <main className="tutorial-main">
        <article className="tutorial-article">
          {chapter.slug === "start" ? (
            <aside className="tutorial-goal">
              <span>教程整体目标</span>
              <p>{tutorialGoal}</p>
            </aside>
          ) : (
            <details className="tutorial-goal tutorial-goal--compact">
              <summary>教程整体目标</summary>
              <p>{tutorialGoal}</p>
            </details>
          )}
          <header className="article-header">
            <span className="article-number">{chapter.number}</span>
            <h1>{chapter.title}</h1>
            <p>{chapter.description}</p>
            {chapter.track === "extension" ? (
              <small className="article-meta article-meta--extension">
                扩展篇 · 预计 {chapter.minutes} 分钟 · 前置：{chapter.prerequisites}
              </small>
            ) : (
              <small className="article-meta">预计 {chapter.minutes} 分钟</small>
            )}
          </header>

          <details className="mobile-toc">
            <summary>本页目录</summary>
            <nav aria-label="移动端本页目录">
              {chapter.toc.map((item) => (
                <a href={`#${item.id}`} key={item.id}>
                  {item.title}
                </a>
              ))}
            </nav>
          </details>

          <div className="mdx-content">{children}</div>

          <nav aria-label="章节翻页" className="chapter-pager">
            {previous ? (
              <Link
                className="chapter-pager__link chapter-pager__link--previous"
                href={`/${previous.slug}`}
              >
                <ArrowIcon />
                <span>
                  <small>{isExtension ? "上一篇" : "上一章"}</small>
                  {previous.label}
                </span>
              </Link>
            ) : isExtension ? (
              <Link
                className="chapter-pager__link chapter-pager__link--previous"
                href="/extensions"
              >
                <ArrowIcon />
                <span>
                  <small>返回</small>
                  扩展篇目录
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
                  <small>{isExtension ? "下一篇" : "下一章"}</small>
                  {next.label}
                </span>
                <ArrowIcon />
              </Link>
            ) : showExtensionEntry ? (
              <Link className="chapter-pager__link chapter-pager__link--next" href="/extensions">
                <span>
                  <small>可选延伸</small>
                  扩展篇
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
