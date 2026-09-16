import type { ReactElement } from "react";

import type { RunSummaryView } from "../lib/snapshot.js";

/**
 * 最近的运行列表：让"重开一次已结束的运行"不必先记住 runId。
 *
 * 数据来自 `GET /api/runs`（读磁盘上的 checkpoint），因此 API 进程重启后依然可用。
 */
export function RunList({
  runs,
  onOpen,
}: {
  runs: RunSummaryView[];
  onOpen(runId: string): void;
}): ReactElement | null {
  if (runs.length === 0) return null;

  return (
    <section className="runs" data-testid="run-list">
      <h3>最近的运行</h3>
      <ul>
        {runs.map((run) => (
          <li key={run.runId}>
            <button type="button" className="run-open" onClick={() => onOpen(run.runId)}>
              打开
            </button>
            <span className="mono run-id">{run.runId}</span>
            <span className="muted small run-task">{run.task ?? "(无任务描述)"}</span>
            <span className="status">
              {run.status ?? "unknown"}
              {run.stopReason === undefined ? "" : ` · ${run.stopReason}`}
            </span>
            {run.live ? <span className="status status-live">实时</span> : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
