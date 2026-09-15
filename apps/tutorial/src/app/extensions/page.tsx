import type { Metadata } from "next";
import Link from "next/link";

import { ArrowIcon, BookIcon } from "@/components/icons";
import { totalMinutes } from "@/lib/chapters";
import { extensionChapters } from "@/lib/extensions";

export const metadata: Metadata = {
  title: "扩展篇",
  description:
    "单 Agent 主线之外的六个专题：多 Agent、MCP、RAG、浏览器操作、语音与复杂并行调度。它们复用主线边界，但不是主线 Capstone 的前置条件。",
};

export default function ExtensionsPage() {
  return (
    <div className="extensions-page">
      <header className="extensions-header">
        <Link className="tutorial-brand" href="/start">
          <BookIcon />
          <span className="tutorial-brand__desktop">
            LinOnward <span>/ Agent Tutorial</span>
          </span>
          <span className="tutorial-brand__mobile">Agent Tutorial</span>
        </Link>
        <Link className="extensions-back" href="/start">
          <ArrowIcon />
          返回主线
        </Link>
      </header>

      <main className="extensions-main">
        <header className="extensions-intro">
          <span className="extensions-intro__eyebrow">
            主线之外 · {extensionChapters.length} 篇 · 约 {totalMinutes(extensionChapters)} 分钟
          </span>
          <h1>扩展篇</h1>
          <p>
            主线刻意停在一个可用、可审计、可恢复的单 Agent。下面六个专题复用主线建立的
            Model、Context、Tool、Policy、State、Trace 与 Eval 边界，
            <strong>不是主线 Capstone 的前置条件</strong>：先在单 Agent 上把边界做稳，再按需要选择。
          </p>
        </header>

        <ol className="extension-list">
          {extensionChapters.map((chapter) => (
            <li className="extension-card" key={chapter.slug}>
              <Link href={`/${chapter.slug}`}>
                <div className="extension-card__head">
                  <span className="extension-card__number">{chapter.number}</span>
                  <strong>{chapter.title}</strong>
                  <small>{chapter.minutes} 分钟</small>
                </div>
                <p>{chapter.description}</p>
                <span className="extension-card__prerequisites">前置：{chapter.prerequisites}</span>
              </Link>
            </li>
          ))}
        </ol>

        <p className="extensions-note">
          扩展篇同样遵守主线的学习契约：每篇都有明确任务、编号步骤与可运行的
          Checkpoint。它们不会修改主线的状态、权限或证据契约，
          只在你已经理解的边界上增加新的能力来源。
        </p>
      </main>
    </div>
  );
}
