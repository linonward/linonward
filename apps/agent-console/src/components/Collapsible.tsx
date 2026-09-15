import type { ReactElement, ReactNode } from "react";

export interface CollapsibleProps {
  title: string;
  /** 折叠时也能看到的一行摘要（行数 / 字符数 / 关键字段）。 */
  summary?: string | undefined;
  defaultOpen?: boolean | undefined;
  className?: string | undefined;
  children: ReactNode;
}

/**
 * 手写折叠块：默认折叠，摘要行给出"值不值得展开"的信息。
 *
 * `open` 只在 `defaultOpen` 为真时传：传 `undefined` 时 React 不再托管该属性，
 * 用户的展开/折叠状态因此在每秒多次重渲染中不会被重置。
 */
export function Collapsible({
  title,
  summary,
  defaultOpen = false,
  className,
  children,
}: CollapsibleProps): ReactElement {
  return (
    <details
      className={className === undefined ? "collapse" : `collapse ${className}`}
      open={defaultOpen ? true : undefined}
    >
      <summary className="collapse-summary">
        <span className="collapse-title">{title}</span>
        {summary === undefined ? null : <span className="muted">{summary}</span>}
      </summary>
      <div className="collapse-body">{children}</div>
    </details>
  );
}
