import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RunForm } from "./components/RunForm.js";
import { RunList } from "./components/RunList.js";
import {
  cancelRun,
  fetchSnapshot,
  listRuns,
  openRunStream,
  type RunFormValues,
  sendAnswer,
  startRun,
} from "./lib/api.js";
import { messageOf } from "./lib/format.js";
import { type JournalRecord, projectRun } from "./lib/journal.js";
import type { RunSnapshotView, RunSummaryView } from "./lib/snapshot.js";
import { readRunId, withRunId } from "./lib/url.js";
import { RunConsole } from "./RunConsole.js";

type Phase = "idle" | "starting" | "streaming" | "done" | "error";

/**
 * 页面根组件：只做三件事——调 `POST /api/run`、订阅该运行的 SSE 流、把 `runId` 写进地址栏。
 *
 * `runId` 进 `?run=` 是"刷新不丢运行"的关键：运行完全由流驱动，而流只认 runId，
 * 只把它放在 React state 里就等于刷新即失忆。恢复时分两路取数：
 * 磁盘上的 checkpoint（快照，进程重启后仍在）与 SSE 的历史补发（`after=0`）。
 *
 * 所有展示逻辑都在 `RunConsole` 与 `projectRun` 里，因此这一层很薄、也很好替换。
 */
export function App(): ReactElement {
  const [records, setRecords] = useState<JournalRecord[]>([]);
  const [runId, setRunId] = useState<string | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | undefined>(undefined);
  const [paused, setPaused] = useState(false);
  const [snapshot, setSnapshot] = useState<RunSnapshotView | undefined>(undefined);
  /** 实时流已经拿不到（API 进程重启 / 频道被挤出缓冲）——界面改说快照。 */
  const [streamUnavailable, setStreamUnavailable] = useState(false);
  const [runs, setRuns] = useState<RunSummaryView[]>([]);
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

  /** 地址栏与 state 同步：刷新后 `?run=` 还在，页面就能自己把这次运行找回来。 */
  const writeUrl = useCallback((nextRunId: string | undefined): void => {
    if (typeof window === "undefined") return;
    const search = withRunId(window.location.search, nextRunId);
    window.history.replaceState(null, "", `${window.location.pathname}${search}`);
  }, []);

  const refreshRuns = useCallback((): void => {
    listRuns()
      .then(setRuns)
      .catch(() => setRuns([]));
  }, []);

  /**
   * 订阅一次运行的实时流；拿不到频道时回落到 checkpoint 快照。
   *
   * EventSource 看不到 HTTP 状态码，所以 404 与网络中断都只表现为 `error`：
   * 这里主动去问一次快照——有快照说明"频道没了但运行还在磁盘上"，没有才是真的断了。
   */
  const connect = useCallback(
    (id: string, after: number): void => {
      closeRef.current?.();
      closeRef.current = openRunStream(id, after, {
        onRecord: (record, seq) => {
          lastSeqRef.current = Math.max(lastSeqRef.current, seq);
          setRecords((previous) => [...previous, record]);
        },
        onDone: () => {
          setPhase("done");
          // 结束后再拉一次快照：状态、用量与"能否中止"都以权威检查点为准，
          // 而不是停在开始那一刻的旧值上。
          void fetchSnapshot(id)
            .then((latest) => {
              if (latest !== undefined) setSnapshot(latest);
            })
            .catch(() => undefined);
          refreshRuns();
        },
        onError: (message) => {
          void fetchSnapshot(id)
            .then((restored) => {
              if (restored === undefined) {
                setError(message);
                setPhase("error");
                return;
              }
              setSnapshot(restored);
              setStreamUnavailable(true);
              setError(undefined);
              setPhase("done");
            })
            .catch(() => {
              setError(message);
              setPhase("error");
            });
        },
      });
    },
    [refreshRuns],
  );

  /** 打开一次运行：先读 checkpoint，再（如果频道还在）接上实时流。 */
  const open = useCallback(
    (id: string): void => {
      closeRef.current?.();
      setRunId(id);
      setRecords([]);
      setError(undefined);
      setStreamUnavailable(false);
      lastSeqRef.current = 0;
      writeUrl(id);

      fetchSnapshot(id)
        .then((restored) => setSnapshot(restored))
        .catch(() => setSnapshot(undefined));

      setPhase("streaming");
      connect(id, 0);
    },
    [connect, writeUrl],
  );

  // 首屏：地址栏里有 `?run=` 就恢复它（刷新、从链接进入都走这条路）。
  useEffect(() => {
    if (typeof window === "undefined") return;
    const restored = readRunId(window.location.search);
    if (restored !== undefined) open(restored);
    refreshRuns();
  }, [open, refreshRuns]);

  const handleSubmit = (values: RunFormValues): void => {
    setPhase("starting");
    setError(undefined);
    setRecords([]);
    setRunId(undefined);
    setSnapshot(undefined);
    setStreamUnavailable(false);
    lastSeqRef.current = 0;
    startRun(values)
      .then((started) => {
        setRunId(started.runId);
        setPhase("streaming");
        writeUrl(started.runId);
        connect(started.runId, 0);
        refreshRuns();
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
        setStreamUnavailable(false);
        setPhase("streaming");
        connect(runId, after);
      })
      .catch((cause: unknown) => {
        setError(messageOf(cause));
        setPhase("error");
      });
  };

  const handleCancel = (): void => {
    if (runId === undefined) return;
    cancelRun(runId)
      .then(() => {
        setError(undefined);
      })
      .catch((cause: unknown) => {
        setError(messageOf(cause));
      });
  };

  const handleNew = (): void => {
    closeRef.current?.();
    setRunId(undefined);
    setRecords([]);
    setSnapshot(undefined);
    setStreamUnavailable(false);
    setError(undefined);
    setPhase("idle");
    lastSeqRef.current = 0;
    writeUrl(undefined);
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

      <RunList runs={runs} onOpen={open} />

      <RunConsole
        view={view}
        streaming={phase === "streaming"}
        paused={paused}
        error={error}
        snapshot={snapshot}
        streamUnavailable={streamUnavailable}
        onTogglePause={() => setPaused((previous) => !previous)}
        onStop={() => {
          closeRef.current?.();
          setPhase("done");
          refreshRuns();
        }}
        onAnswer={handleAnswer}
        onNew={handleNew}
        onCancel={handleCancel}
      />
    </div>
  );
}
