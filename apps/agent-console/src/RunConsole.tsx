import { type ReactElement, useEffect, useRef } from "react";

import { AnswerBox } from "./components/AnswerBox.js";
import { Collapsible } from "./components/Collapsible.js";
import { SnapshotPanel } from "./components/SnapshotPanel.js";
import { StopBanner } from "./components/StopBanner.js";
import { Timeline } from "./components/Timeline.js";
import { UsagePanel } from "./components/UsagePanel.js";
import { pendingQuestion, type RunView } from "./lib/journal.js";
import { pendingExpired, type RunSnapshotView } from "./lib/snapshot.js";

export interface RunConsoleProps {
  view: RunView;
  streaming: boolean;
  paused: boolean;
  error?: string | undefined;
  /** checkpoint 兜底数据；实时流不可用时它是唯一能看到的东西。 */
  snapshot?: RunSnapshotView | undefined;
  /** 实时流已经拿不到了（API 进程重启 / 频道被挤出缓冲）。 */
  streamUnavailable?: boolean | undefined;
  onTogglePause(): void;
  onStop(): void;
  onAnswer(input: { requestId: string; text: string }): void;
  /** 清空当前运行并去掉地址栏里的 `?run=`，回到全新状态。 */
  onNew(): void;
  /** 中止正在执行的运行；运行停在等待回答时没有可中止的东西。 */
  onCancel(): void;
}

/**
 * 运行的展示层：全部输入来自 `view`（纯投影结果）。
 *
 * 这是无副作用（除自动滚动外）的组件，因此可以在 `react-dom/server` 里直接渲染做断言。
 */
export function RunConsole({
  view,
  streaming,
  paused,
  error,
  snapshot,
  streamUnavailable = false,
  onTogglePause,
  onStop,
  onAnswer,
  onNew,
  onCancel,
}: RunConsoleProps): ReactElement {
  const endRef = useRef<HTMLDivElement | null>(null);
  const rounds = view.rounds.length;
  const logLines = view.logLines.length;

  useEffect(() => {
    if (paused) return;
    const node = endRef.current;
    if (node === null) return;
    node.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [paused, rounds, logLines]);

  // 服务端确认"正在执行"时允许中止；刚提交、还没有第一份 checkpoint 时用"正在接收流"兜底
  // （那时快照还不存在）。停在等待回答的运行会先收到 done，因此按钮自动禁用。
  const cancellable = snapshot?.cancellable === true || streaming;

  const question = pendingQuestion(view);
  // 时间线里没有待答请求时才回落到快照里的那条：两者不会重复渲染同一个请求。
  const snapshotQuestion = question === undefined ? snapshot?.pending : undefined;
  // 频道没了也照样能答：服务端会用磁盘上的 checkpoint + journal 重建这次运行（`rehydrate`）。
  // 但过期的审批凭证没必要给表单——提交必然被拒绝（15 分钟 TTL）。
  const snapshotCanAnswer = snapshotQuestion !== undefined && !pendingExpired(snapshotQuestion);
  // 频道还在且有记录时，时间线比快照丰富；否则（进程重启、缓冲被挤出）只能给快照。
  const showSnapshot =
    snapshot !== undefined &&
    (streamUnavailable || view.rounds.length === 0 || snapshotQuestion !== undefined);

  return (
    <div className="console">
      <div className="console-bar">
        <span className="mono">runId={view.runId}</span>
        <span className={streaming ? "status status-live" : "status"}>
          {streaming ? "实时接收中" : view.done ? "已结束" : "未在接收"}
        </span>
        <button type="button" onClick={onTogglePause}>
          {paused ? "恢复自动滚动" : "暂停自动滚动"}
        </button>
        <button type="button" onClick={onCancel} disabled={!cancellable}>
          中止运行
        </button>
        <button type="button" onClick={onStop} disabled={!streaming}>
          断开实时流
        </button>
        <button type="button" onClick={onNew}>
          清空并新建
        </button>
      </div>

      {error === undefined ? null : <p className="error">{error}</p>}

      <StopBanner view={view} />

      {showSnapshot ? (
        <SnapshotPanel snapshot={snapshot} streamUnavailable={streamUnavailable} />
      ) : null}

      {question === undefined ? null : (
        <AnswerBox requestId={question.requestId} reason={question.reason} onAnswer={onAnswer} />
      )}

      {snapshotCanAnswer ? (
        <AnswerBox
          requestId={snapshotQuestion.requestId}
          question={snapshotQuestion.question}
          reason={snapshotQuestion.reason}
          onAnswer={onAnswer}
        />
      ) : null}

      <div className="console-grid">
        <main className="console-main">
          {view.start === undefined ? null : (
            <Collapsible
              title="运行元信息"
              summary={`cwd=${view.start.cwd ?? "unknown"} · model=${view.start.modelId ?? "(injected)"}`}
            >
              <pre className="mono">{JSON.stringify(view.start, null, 2)}</pre>
            </Collapsible>
          )}
          <Timeline view={view} />
        </main>
        <UsagePanel view={view} />
      </div>

      <div ref={endRef} />
    </div>
  );
}
