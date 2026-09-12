import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://notes.linonward.com"),
  title: { default: "linonward notes", template: "%s · linonward notes" },
  description: "记录成长、日常与探索。每一步，都算数。",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
