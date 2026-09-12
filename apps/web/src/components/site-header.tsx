import Link from "next/link";

export function SiteHeader() {
  return (
    <header className="border-b border-[#0c2030]/15 bg-[#f8f6f1]/95">
      <div className="mx-auto flex h-20 w-[min(1120px,calc(100%_-_40px))] items-center justify-between">
        <Link className="text-xl font-extrabold tracking-[-0.04em] no-underline" href="/">
          linonward notes
        </Link>
        <nav className="flex items-center gap-7 text-sm font-semibold">
          <Link className="no-underline hover:text-[#d95f12]" href="/">
            文章
          </Link>
          <a className="no-underline hover:text-[#d95f12]" href="https://www.linonward.com">
            关于
          </a>
        </nav>
      </div>
    </header>
  );
}
