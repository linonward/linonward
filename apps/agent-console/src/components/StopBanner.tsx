import type { ReactElement } from "react";

import { formatJson } from "../lib/format.js";
import type { RunView } from "../lib/journal.js";
import { Collapsible } from "./Collapsible.js";

/**
 * 结束横幅：status / stopReason 必有；预算耗尽或计划阻塞时补上 detail 与 hint。
 *
 * `hint` 由事件 detail 推导（`deriveStopHint`），因此"为什么停"和机器可读字段
 * 永远来自同一份数据，不会出现两套说法。
 */
export function StopBanner({ view }: { view: RunView }): ReactElement | null {
  const stop = view.stop;
  if (stop === undefined && view.errors.length === 0) return null;

  const detailKind = stop?.detailKind;
  const warn = detailKind === "budget_exhausted" || detailKind === "plan_blocked";

  return (
    <section className={warn ? "banner banner-warn" : "banner"} data-testid="stop-banner">
      <div className="banner-head">
        <strong>运行结束</strong>
        <span className="mono">status={stop?.status ?? "unknown"}</span>
        <span className="mono">stopReason={stop?.stopReason ?? "unknown"}</span>
        {detailKind === undefined ? null : <span className="tag tag-warn">{detailKind}</span>}
      </div>

      {stop?.hint === undefined ? null : <p className="banner-hint">{stop.hint}</p>}

      {view.errors.length === 0 ? null : (
        <ul className="banner-errors">
          {view.errors.map((message, index) => (
            <li key={`error-${index}`} className="mono">
              {message}
            </li>
          ))}
        </ul>
      )}

      {stop?.detail === undefined ? null : (
        <Collapsible title="停止事件 detail" summary={detailKind}>
          <pre className="mono">{formatJson(stop.detail)}</pre>
        </Collapsible>
      )}
    </section>
  );
}
