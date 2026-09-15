import type { ReactElement } from "react";

import { formatCost, formatCount, formatDuration, formatJson } from "../lib/format.js";
import type { RunSnapshotView } from "../lib/snapshot.js";
import { Collapsible } from "./Collapsible.js";

function Row({ label, value }: { label: string; value: string }): ReactElement {
  return (
    <div className="usage-row">
      <span className="usage-label">{label}</span>
      <span className="usage-value mono">{value}</span>
    </div>
  );
}

/**
 * checkpoint 快照面板：**实时流不可用时的兜底**。
 *
 * 运行由 SSE 驱动，而频道活在 API 进程的内存里；进程一重启，浏览器就再也拿不到
 * 时间线。但磁盘上的 checkpoint 还在，界面至少要能说清：这次运行到哪一步、
 * 为什么停、花了多少、以及要不要回答一个问题。
 */
export function SnapshotPanel({
  snapshot,
  streamUnavailable,
}: {
  snapshot: RunSnapshotView;
  streamUnavailable: boolean;
}): ReactElement {
  const { budget, usage } = snapshot;
  const steps = `${formatCount(budget.modelSteps)}/${formatCount(budget.maxSteps)}`;
  const tools = `${formatCount(budget.toolCalls)}/${formatCount(budget.maxToolCalls)}`;

  return (
    <section className="snapshot" data-testid="snapshot-panel">
      <h3>运行快照（来自 checkpoint）</h3>
      {streamUnavailable ? (
        <p className="muted small">
          实时流不可用：API 服务进程可能已重启，或该运行的频道记录已被挤出缓冲。
          以下内容来自磁盘上最后一次 checkpoint；要继续这次运行，请在原进程里重新启动它。
        </p>
      ) : (
        <p className="muted small">实时流仍在，这里是 checkpoint 里的最新状态。</p>
      )}

      <div className="snapshot-body">
        <div className="snapshot-rows">
          {snapshot.task === undefined ? null : <Row label="任务" value={snapshot.task} />}
          <Row
            label="状态"
            value={`${snapshot.status ?? "unknown"}${
              snapshot.stopReason === undefined ? "" : ` · stopReason=${snapshot.stopReason}`
            }`}
          />
          <Row label="checkpoint 时间" value={snapshot.savedAt ?? "unknown"} />
          <Row label="模型步数" value={steps} />
          <Row label="工具调用" value={tools} />
          <Row label="输入 tokens" value={formatCount(usage?.inputTokens)} />
          <Row label="输出 tokens" value={formatCount(usage?.outputTokens)} />
          <Row label="墙钟" value={formatDuration(usage?.wallMs)} />
          <Row
            label="估算成本"
            value={usage?.costUsd === undefined ? "unknown" : formatCost(usage.costUsd, true)}
          />
          {snapshot.changedFiles.length === 0 ? null : (
            <Row label="改动文件" value={snapshot.changedFiles.join(", ")} />
          )}
          {snapshot.pending === undefined ? null : (
            <Row
              label="等待回答"
              value={`requestId=${snapshot.pending.requestId}${
                snapshot.pending.reason.length === 0 ? "" : ` · ${snapshot.pending.reason}`
              }`}
            />
          )}
        </div>

        {snapshot.pending === undefined ? null : (
          <p className="muted small">
            {snapshot.pending.question.length === 0 ? null : `${snapshot.pending.question} `}
            {streamUnavailable
              ? "API 进程已重启，这次运行无法继续：批准账本与运行上下文都活在进程内存里。要接着做，请在原进程里运行，或重新发起同一任务。"
              : "可以在下面提交回答，运行会接着往下走。"}
          </p>
        )}

        {snapshot.plan === undefined ? null : (
          <Collapsible title="任务计划" summary="来自 checkpoint 的 plan">
            <pre className="mono">{formatJson(snapshot.plan)}</pre>
          </Collapsible>
        )}
      </div>
    </section>
  );
}
