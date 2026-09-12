import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";
import { brand } from "@/lib/brand";

const metadataBase = new URL(brand.siteUrl);
const themeScript = `
  (() => {
    try {
      const saved = localStorage.getItem("linonward-theme");
      const theme = saved === "light" || saved === "dark"
        ? saved
        : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
      document.documentElement.dataset.theme = theme;
      document.documentElement.style.colorScheme = theme;
    } catch {}
  })();
`;
const websiteSchema = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  "@id": `${brand.siteUrl}/#website`,
  url: brand.siteUrl,
  name: `${brand.englishName} ${brand.chineseName}`,
  description: brand.description,
  inLanguage: "zh-CN",
  sameAs: brand.socialLinks.map(({ href }) => href),
};

export const metadata: Metadata = {
  title: brand.title,
  description: brand.description,
  icons: { icon: brand.assets.darkLogo, apple: brand.assets.darkLogo },
  metadataBase,
  alternates: { canonical: "/" },
  openGraph: {
    title: brand.title,
    description: brand.description,
    url: "/",
    siteName: `${brand.englishName} ${brand.chineseName}`,
    locale: "zh_CN",
    type: "website",
    images: [
      {
        url: brand.assets.hero,
        width: 1672,
        height: 941,
        alt: "linonward 山路与日出品牌主视觉",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: brand.title,
    description: brand.description,
    site: brand.xHandle,
    creator: brand.xHandle,
    images: [{ url: brand.assets.hero, alt: "linonward 山路与日出品牌主视觉" }],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className="m-0 bg-page font-sans text-base leading-[1.7] text-ink [text-rendering:optimizeLegibility] transition-[color,background-color] duration-220">
        <Script
          id="theme-init"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: themeScript }}
        />
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(websiteSchema).replace(/</g, "\\u003c"),
          }}
        />
        {children}
      </body>
    </html>
  );
}
