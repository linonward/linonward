import type { ReactElement } from "react";

export interface ReasoningBlockProps {
  step: number;
  reasoning?: string[] | undefined;
}

/**
 * 每轮的思维链区块。
 *
 * 有推理时默认展开并突出显示；模型没有返回可见推理时，明确写出来——
 * 而不是留一块空白让人怀疑界面坏了。
 */
export function ReasoningBlock({ step, reasoning }: ReasoningBlockProps): ReactElement {
  if (reasoning === undefined || reasoning.length === 0) {
    return (
      <div className="reasoning reasoning-empty" data-testid={`reasoning-${step}`}>
        <span className="reasoning-title">模型思考</span>
        <span className="muted">（模型未返回可见推理）</span>
      </div>
    );
  }

  const characters = reasoning.reduce((total, block) => total + block.length, 0);
  return (
    <details className="reasoning" open data-testid={`reasoning-${step}`}>
      <summary className="reasoning-summary">
        <span className="reasoning-title">模型思考</span>
        <span className="muted">
          {reasoning.length} 段 · {characters.toLocaleString("en-US")} 字符
        </span>
      </summary>
      <div className="reasoning-body">
        {reasoning.map((block, index) => (
          <pre className="reasoning-block" key={`${step}-reasoning-${index}`}>
            {block}
          </pre>
        ))}
      </div>
    </details>
  );
}
