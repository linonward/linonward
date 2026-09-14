"use client";

import type { ReactNode, SyntheticEvent } from "react";
import { useState } from "react";

import { MenuIcon } from "./icons";

interface MobileNavigationProps {
  children: ReactNode;
}

export function MobileNavigation({ children }: MobileNavigationProps) {
  const [open, setOpen] = useState(false);

  function handleToggle(event: SyntheticEvent<HTMLDetailsElement>): void {
    setOpen(event.currentTarget.open);
  }

  return (
    <details className="mobile-menu" onToggle={handleToggle} open={open}>
      <summary aria-expanded={open} aria-label={open ? "关闭章节导航" : "打开章节导航"}>
        <MenuIcon />
      </summary>
      <div className="mobile-menu__panel">{children}</div>
    </details>
  );
}
