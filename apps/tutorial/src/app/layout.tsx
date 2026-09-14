import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "从 0 构建可用的 Agent",
    template: "%s｜Agent Tutorial",
  },
  description:
    "从模型调用开始，逐步构建一个能理解任务、使用工具、修改代码并完成验证的本地工程 Agent。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html data-scroll-behavior="smooth" lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
