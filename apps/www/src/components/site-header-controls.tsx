"use client";

import { Menu, X } from "lucide-react";
import { useEffect, useState } from "react";
import { ThemeToggle } from "@/components/theme-toggle";

type NavItem = {
  label: string;
  href: string;
};

export function SiteHeaderControls({ items }: { items: readonly NavItem[] }) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [open]);

  return (
    <>
      <ThemeToggle />
      <button
        className="hidden size-11 cursor-pointer items-center justify-center border-0 bg-transparent text-ink max-[899px]:inline-flex"
        type="button"
        aria-label={open ? "关闭导航菜单" : "打开导航菜单"}
        aria-expanded={open}
        aria-controls="mobile-navigation"
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <X aria-hidden="true" /> : <Menu aria-hidden="true" />}
      </button>
      <div
        id="mobile-navigation"
        className="invisible absolute top-full -right-5 -left-5 hidden max-h-0 overflow-hidden border-b border-transparent bg-page opacity-0 transition-[max-height,opacity,visibility] duration-240 max-[899px]:grid data-[open=true]:visible data-[open=true]:max-h-80 data-[open=true]:border-line data-[open=true]:pt-2 data-[open=true]:pb-3.5 data-[open=true]:opacity-100"
        data-open={open}
      >
        {items.map((item) => (
          <a
            className="px-5 py-3.5 font-bold"
            key={item.href}
            href={item.href}
            onClick={() => setOpen(false)}
          >
            {item.label}
          </a>
        ))}
      </div>
    </>
  );
}
