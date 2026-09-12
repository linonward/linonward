import Link from "next/link";
import type { Metadata } from "next";
import { InterviewFeedbackForm } from "@/components/interview-feedback-form";

export const metadata: Metadata = {
  title: "面试后复盘",
  robots: { index: false, follow: false },
};

export default async function FeedbackPage({
  searchParams,
}: {
  searchParams: Promise<{ leadId?: string }>;
}) {
  const { leadId } = await searchParams;
  if (!leadId) {
    return (
      <main className="feedback-page">
        <div className="feedback-shell feedback-empty">
          <h1>需要专属回访链接</h1>
          <p>请通过提交资料后的页面或工作人员发送的链接进入。</p>
          <Link className="button" href="/">
            返回首页
          </Link>
        </div>
      </main>
    );
  }
  return (
    <main className="feedback-page">
      <div className="feedback-shell">
        <p className="overline">Interview Pack · 面试后 3 分钟复盘</p>
        <h1>哪些真的被问到了？</h1>
        <p className="feedback-intro">
          这份回访会直接帮助我们校准公司 × 岗位 × 轮次的准备重点，也能为你的下一轮继续准备。
        </p>
        <InterviewFeedbackForm leadId={leadId} />
      </div>
    </main>
  );
}
