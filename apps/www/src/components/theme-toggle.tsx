"use client";

import { Moon, Sun } from "lucide-react";

const storageKey = "linonward-theme";

export function ThemeToggle() {
  const toggleTheme = () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    document.documentElement.style.colorScheme = next;
    try {
      window.localStorage.setItem(storageKey, next);
    } catch {}
  };

  return (
    <button
      className="inline-flex size-10.5 shrink-0 cursor-pointer items-center justify-center rounded-full border border-line bg-transparent text-ink transition-[color,background-color,border-color,transform] duration-180 hover:rotate-8 hover:border-brand-orange hover:bg-brand-orange hover:text-brand-navy motion-reduce:hover:rotate-0"
      type="button"
      aria-label="切换深色/浅色模式"
      title="切换深色/浅色模式"
      onClick={toggleTheme}
    >
      <Moon className="size-4.75 stroke-2 dark:hidden" aria-hidden="true" />
      <Sun className="hidden size-4.75 stroke-2 dark:block" aria-hidden="true" />
    </button>
  );
}
