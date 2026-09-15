import { type ReactElement, useEffect, useMemo, useRef, useState } from "react";
import { RunForm } from "./components/RunForm.js";
import { openRunStream, type RunFormValues, sendAnswer, startRun } from "./lib/api.js";
import { messageOf } from "./lib/format.js";
import { type JournalRecord, projectRun } from "./lib/journal.js";
import { RunConsole } from "./RunConsole.js";

type Phase = "idle" | "starting" | "streaming" | "done" | "error";

/**
 * 页面根组件：只做两件事——调 `POST /api/run`，以及订阅该运行的 SSE 流。
 *
 * 所有展示逻辑都在 `RunConsole` 与 `projectRun` 里，因此这一层很薄、也很好替换。
 */
export function App(): ReactElement {
  const [records, setRecords] = useState<JournalRecord[]>([]);
  const [runId, setRunId] = useState<string | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | undefined>(undefined);
  const [paused, setPaused] = useState(false);
  const closeRef = useRef<(() => void) | undefined>(undefined);
  /** 已收到的最后一条记录序号：重连时用它做 `after`，历史记录不会重复渲染。 */
  const lastSeqRef = useRef(0);

  useEffect(
    () => () => {
      closeRef.current?.();
    },
    [],
  );

  const view = useMemo(() => projectRun(runId ?? "(未开始)", records), [runId, records]);

  const connect = (id: string, after: number): void => {
    closeRef.current?.();
    closeRef.current = openRunStream(id, after, {
      onRecord: (record, seq) => {
        lastSeqRef.current = Math.max(lastSeqRef.current, seq);
        setRecords((previous) => [...previous, record]);
      },
      onDone: () => {
        setPhase("done");
      },
      onError: (message) => {
        setError(message);
        setPhase("error");
      },
    });
  };

  const handleSubmit = (values: RunFormValues): void => {
    setPhase("starting");
    setError(undefined);
    setRecords([]);
    setRunId(undefined);
    lastSeqRef.current = 0;
    startRun(values)
      .then((started) => {
        setRunId(started.runId);
        setPhase("streaming");
        connect(started.runId, 0);
      })
      .catch((cause: unknown) => {
        setError(messageOf(cause));
        setPhase("error");
      });
  };

  const handleAnswer = (input: { requestId: string; text: string }): void => {
    if (runId === undefined) return;
    const after = lastSeqRef.current;
    sendAnswer(runId, input.requestId, input.text)
      .then(() => {
        setError(undefined);
        setPhase("streaming");
        connect(runId, after);
      })
      .catch((cause: unknown) => {
        setError(messageOf(cause));
        setPhase("error");
      });
  };

  return (
    <div className="app">
      <header className="app-head">
        <h1>Agent Console</h1>
        <p className="muted">
          实时呈现一次真实的 agent-from-scratch 运行：模型请求 / 思维链 / 输出、工具调用、
          计划变化、用量与成本。密钥只存在于本地 API 服务进程里，页面与日志都不会出现它。
        </p>
      </header>

      <RunForm busy={phase === "starting" || phase === "streaming"} onSubmit={handleSubmit} />

      <RunConsole
        view={view}
        streaming={phase === "streaming"}
        paused={paused}
        error={error}
        onTogglePause={() => setPaused((previous) => !previous)}
        onStop={() => {
          closeRef.current?.();
          setPhase("done");
        }}
        onAnswer={handleAnswer}
      />
    </div>
  );
}
