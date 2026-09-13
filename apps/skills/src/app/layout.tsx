import type { Metadata } from "next";
import "./globals.css";

const siteUrl = new URL("https://skills.linonward.com");

export const metadata: Metadata = {
  metadataBase: siteUrl,
  title: {
    default: "LinOnward Skills｜工程决策技能集",
    template: "%s｜LinOnward Skills",
  },
  description: "从模糊需求到安全交付，为独立开发者和小团队补上关键工程判断。",
  alternates: { canonical: "/" },
  openGraph: {
    title: "LinOnward Skills",
    description: "从模糊需求到安全交付的工程决策技能集。",
    siteName: "LinOnward Skills",
    locale: "zh_CN",
    type: "website",
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
