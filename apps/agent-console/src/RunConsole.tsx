import { type ReactElement, useEffect, useRef, useState } from "react";

import { Collapsible } from "./components/Collapsible.js";
import { StopBanner } from "./components/StopBanner.js";
import { Timeline } from "./components/Timeline.js";
import { UsagePanel } from "./components/UsagePanel.js";
import { pendingQuestion, type RunView } from "./lib/journal.js";

export interface RunConsoleProps {
  view: RunView;
  streaming: boolean;
  paused: boolean;
  error?: string | undefined;
  onTogglePause(): void;
  onStop(): void;
  onAnswer(input: { requestId: string; text: string }): void;
}

function AnswerBox({
  requestId,
  reason,
  onAnswer,
}: {
  requestId: string;
  reason: string;
  onAnswer(input: { requestId: string; text: string }): void;
}): ReactElement {
  const [text, setText] = useState("");
  return (
    <form
      className="answer"
      onSubmit={(event) => {
        event.preventDefault();
        if (text.trim().length === 0) return;
        onAnswer({ requestId, text: text.trim() });
        setText("");
      }}
    >
      <strong>需要回答（requestId={requestId}）</strong>
      <p className="muted small">{reason}</p>
      <div className="answer-row">
        <input
          aria-label="answer-text"
          value={text}
          placeholder="批准 / 澄清内容"
          onChange={(event) => setText(event.target.value)}
        />
        <button className="primary" type="submit" disabled={text.trim().length === 0}>
          提交并继续
        </button>
      </div>
    </form>
  );
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
  onTogglePause,
  onStop,
  onAnswer,
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

  const question = pendingQuestion(view);

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
        <button type="button" onClick={onStop} disabled={!streaming}>
          断开实时流
        </button>
      </div>

      {error === undefined ? null : <p className="error">{error}</p>}

      <StopBanner view={view} />

      {question === undefined ? null : (
        <AnswerBox requestId={question.requestId} reason={question.reason} onAnswer={onAnswer} />
      )}

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
