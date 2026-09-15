"use client";

import Link from "next/link";
import { useEffect } from "react";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="page-state">
      <div>
        <p className="overline">暂时无法加载</p>
        <h1>页面遇到了一点问题</h1>
        <p>请稍后重试，或返回首页重新开始。</p>
        <div className="page-state-actions">
          <button className="button" onClick={reset} type="button">
            再试一次
          </button>
          <Link className="text-link" href="/">
            返回首页
          </Link>
        </div>
      </div>
    </main>
  );
}
