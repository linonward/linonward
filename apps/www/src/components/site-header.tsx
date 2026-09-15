import Image from "next/image";
import { SiteHeaderControls } from "@/components/site-header-controls";
import { brand } from "@/lib/brand";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-50 h-[var(--header-height)] border-b border-line bg-header backdrop-blur-md">
      <nav
        className="relative mx-auto flex h-full w-[min(1280px,calc(100%_-_48px))] items-center justify-between max-[899px]:w-[calc(100%_-_40px)]"
        aria-label="主导航"
      >
        <a
          className="relative block w-44 leading-none max-sm:w-37.5"
          href="#top"
          aria-label="linonward 首页"
        >
          <Image
            className="h-auto w-full transition-[filter] duration-220 dark:brightness-0 dark:invert"
            src={brand.assets.horizontalLogo}
            alt="linonward 林昂在路上"
            width={2172}
            height={724}
            priority
            sizes="(max-width: 767px) 150px, 176px"
          />
          <span
            className="pointer-events-none absolute top-[23%] left-[23%] aspect-square w-[6.35%] rounded-full bg-brand-orange opacity-0 transition-opacity duration-220 dark:opacity-100"
            aria-hidden="true"
          />
        </a>
        <div className="flex items-center gap-4.5">
          <div className="flex items-center gap-9.5 text-[15px] font-[650] max-[899px]:hidden">
            {brand.navItems.map((item) => (
              <a
                className="relative py-2 after:absolute after:right-full after:bottom-0.5 after:left-0 after:h-0.5 after:bg-brand-orange after:transition-[right] after:duration-220 after:content-[''] hover:after:right-0 focus-visible:after:right-0"
                key={item.href}
                href={item.href}
              >
                {item.label}
              </a>
            ))}
          </div>
          <SiteHeaderControls items={brand.navItems} />
        </div>
      </nav>
    </header>
  );
}
