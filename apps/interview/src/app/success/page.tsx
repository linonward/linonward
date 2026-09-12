import Link from "next/link";
import type { Metadata } from "next";
import { ArrowRight, Check } from "lucide-react";

export const metadata: Metadata = {
  title: "资料已提交",
  robots: { index: false, follow: false },
};

export default async function SuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ leadId?: string }>;
}) {
  const { leadId } = await searchParams;
  const feedbackHref = leadId ? `/feedback?leadId=${encodeURIComponent(leadId)}` : "/feedback";
  return (
    <main className="success">
      <div className="success-card">
        <div className="success-main">
          <div className="success-mark">
            <Check aria-hidden="true" />
          </div>
          <p className="overline">资料已提交</p>
          <h1>我们收到了你的面试资料</h1>
          <p className="success-copy">
            接下来会由人工联系你，确认这场面试的交付安排。请留意你填写的联系方式；面试结束后，也请用下方链接回填真实题目和结果。
          </p>
          <Link className="success-feedback-link" href={feedbackHref}>
            面试后填写 3 分钟复盘
          </Link>
          <Link className="button" href="/">
            返回首页 <ArrowRight aria-hidden="true" />
          </Link>
        </div>
        <p className="success-footer">Interview Pack · 为这场面试，做好有针对性的准备。</p>
      </div>
    </main>
  );
}
