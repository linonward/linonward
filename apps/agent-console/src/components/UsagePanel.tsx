import type { ReactElement } from "react";

import { formatCost, formatCount, formatDuration } from "../lib/format.js";
import type { RunView } from "../lib/journal.js";

function Row({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="usage-row">
      <span className="usage-label">{label}</span>
      <span className="usage-value mono">{value}</span>
    </div>
  );
}

function BudgetBar({
  label,
  current,
  max,
}: {
  label: string;
  current: number;
  max: number | undefined;
}): ReactElement {
  const ratio = max === undefined || max <= 0 ? 0 : Math.min(1, current / max);
  return (
    <div className="budget">
      <div className="budget-head">
        <span>{label}</span>
        <span className="mono">
          {current}
          {max === undefined ? " / unknown" : ` / ${max}`}
        </span>
      </div>
      <div className="budget-track" role="presentation">
        <div
          className={ratio >= 1 ? "budget-fill budget-fill-full" : "budget-fill"}
          style={{ width: `${(ratio * 100).toFixed(1)}%` }}
        />
      </div>
    </div>
  );
}

/** 侧边实时面板：累计用量、估算成本与预算进度。 */
export function UsagePanel({ view }: { view: RunView }): ReactElement {
  const { usage, budget } = view;
  const cost = formatCost(usage.costUsd, usage.costKnown);

  return (
    <aside className="usage" data-testid="usage-panel">
      <h3>用量</h3>
      <Row label="输入 tokens" value={formatCount(usage.inputTokens)} />
      <Row label="输出 tokens" value={formatCount(usage.outputTokens)} />
      <Row label="缓存 tokens" value={formatCount(usage.cachedInputTokens)} />
      <Row label="模型调用" value={formatCount(usage.modelCalls)} />
      <Row label="工具调用" value={formatCount(usage.toolCalls)} />
      <Row label="墙钟" value={formatDuration(usage.wallMs)} />
      <Row label="估算成本" value={usage.costKnown ? cost : `${cost}（cost=unknown）`} />

      {usage.prices === undefined ? null : (
        <p className="muted small">
          价格表 asOf={usage.prices.asOf ?? "unknown"}
          {usage.prices.source === undefined ? "" : ` · source=${usage.prices.source}`}
        </p>
      )}
      {usage.costBasis === undefined ? null : <p className="muted small">{usage.costBasis}</p>}
      <p className="muted small">
        口径：{usage.source === "run" ? "运行汇总记录" : "逐次调用累加"}
      </p>

      <h3>预算</h3>
      <BudgetBar label="模型步数" current={budget.modelSteps} max={budget.maxSteps} />
      <BudgetBar label="工具调用" current={budget.toolCalls} max={budget.maxToolCalls} />
    </aside>
  );
}
