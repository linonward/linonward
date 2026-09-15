import { type ComponentProps, isValidElement, type ReactNode } from "react";

import { CodeBlock } from "./code-block";

interface MdxCodeElementProps {
  children?: ReactNode;
  className?: string;
}

export function MdxCodeBlock({ children }: ComponentProps<"pre">) {
  if (!isValidElement<MdxCodeElementProps>(children)) {
    return <pre>{children}</pre>;
  }

  const source = children.props.children;
  if (typeof source !== "string") {
    return <pre>{children}</pre>;
  }

  const language = children.props.className?.replace(/^language-/, "") || "text";
  return <CodeBlock language={language}>{source}</CodeBlock>;
}
