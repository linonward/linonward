import type { ReactNode } from "react";

interface SectionHeadingProps {
  children: ReactNode;
  id: string;
}

export function SectionHeading({ children, id }: SectionHeadingProps) {
  return <h2 id={id}>{children}</h2>;
}
