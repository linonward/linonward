import type { ReactNode } from "react";

interface CalloutProps {
  children: ReactNode;
  title?: string;
}

export function Callout({ children, title = "关键判断" }: CalloutProps) {
  return (
    <aside className="callout">
      <strong>{title}</strong>
      <div>{children}</div>
    </aside>
  );
}
