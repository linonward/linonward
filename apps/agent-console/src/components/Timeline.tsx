import type { ReactElement } from "react";

import { formatDuration, formatJson, summarizeText } from "../lib/format.js";
import type { ModelRoundView, RunView, ToolCallView } from "../lib/journal.js";
import { Collapsible } from "./Collapsible.js";
import { ReasoningBlock } from "./ReasoningBlock.js";

function ToolCallEntry({ call }: { call: ToolCallView }): ReactElement {
  const result = call.result;
  const status =
    result === undefined
      ? "运行中"
      : result.waiting !== undefined
        ? `等待回答 requestId=${result.waiting.requestId}`
        : `ok=${String(result.ok ?? false)}${result.errorCode === undefined ? "" : ` error=${result.errorCode}`}`;

  return (
    <div className="tool-call" data-testid={`tool-${call.callId}`}>
      <div className="tool-head">
        <span className="tag">{call.name}</span>
        <span className="mono small">callId={call.callId}</span>
        <span className="mono small">
          toolMs={formatDuration(call.durationMs ?? result?.durationMs)}
        </span>
        <span className={result?.ok === false ? "status status-bad" : "status"}>{status}</span>
      </div>
      <pre className="mono args">{call.argumentsJson}</pre>
      {result?.policy === undefined ? null : (
        <p className="muted small mono">policy={formatJson(result.policy)}</p>
      )}
      {result?.reason === undefined ? null : <p className="muted small">reason={result.reason}</p>}
      {result?.output === undefined ? null : (
        <Collapsible title="工具结果 output" summary={summarizeText(result.output)}>
          <pre className="mono">{result.output}</pre>
        </Collapsible>
      )}
      {result?.waiting === undefined ? null : (
        <p className="muted small">等待原因：{result.waiting.reason}</p>
      )}
    </div>
  );
}

function Round({ round }: { round: ModelRoundView }): ReactElement {
  return (
    <section className="round" data-testid={`round-${round.step}`}>
      <header className="round-head">
        <span className="round-title">第 {round.step} 轮</span>
        <span className="tag">phase={round.phase}</span>
        <span className="mono small">modelMs={formatDuration(round.durationMs)}</span>
        {round.usage === undefined ? null : (
          <span className="mono small">
            in={round.usage.inputTokens ?? "unknown"} out={round.usage.outputTokens ?? "unknown"}{" "}
            cached={round.usage.cachedInputTokens ?? "unknown"}
          </span>
        )}
      </header>

      <ReasoningBlock step={round.step} reasoning={round.reasoning} />

      {round.request === undefined ? null : (
        <Collapsible
          title="模型请求"
          summary={`system prompt ${summarizeText(round.request.instructions)} · 输入 ${round.request.input.length} 条`}
        >
          <h4>system prompt</h4>
          <pre className="mono">{round.request.instructions}</pre>
          <h4>input</h4>
          {round.request.input.map((message, index) => (
            <Collapsible
              key={`${round.step}-input-${index}`}
              title={`input[${index}] role=${message.role}`}
              summary={summarizeText(message.content)}
            >
              <pre className="mono">{message.content}</pre>
            </Collapsible>
          ))}
          {round.request.outputs.length === 0 ? null : (
            <>
              <h4>上一批工具输出</h4>
              {round.request.outputs.map((output, index) => (
                <Collapsible
                  key={`${round.step}-output-${index}`}
                  title={`output[${index}] callId=${output.callId}`}
                  summary={summarizeText(output.output)}
                >
                  <pre className="mono">{output.output}</pre>
                </Collapsible>
              ))}
            </>
          )}
          <h4>tools</h4>
          <p className="mono small">{round.request.toolNames.join(", ") || "(none)"}</p>
          {round.request.previousResponseId === undefined ? null : (
            <p className="mono small">previousResponseId={round.request.previousResponseId}</p>
          )}
        </Collapsible>
      )}

      <div className="section">
        <h4>模型输出</h4>
        {round.finalText === undefined || round.finalText.length === 0 ? (
          <p className="muted">（本轮没有最终文本）</p>
        ) : (
          <pre className="mono final-text">{round.finalText}</pre>
        )}
        {round.toolCalls.length === 0 ? null : (
          <ul className="tool-call-list">
            {round.toolCalls.map((call) => (
              <li key={call.callId}>
                <span className="tag">{call.name}</span>
                <pre className="mono args">{call.argumentsJson}</pre>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="section">
        <h4>工具调用</h4>
        {round.toolCalls.length === 0 ? (
          <p className="muted">（本轮没有工具调用）</p>
        ) : (
          round.toolCalls.map((call) => <ToolCallEntry key={call.callId} call={call} />)
        )}
      </div>
    </section>
  );
}

/** 运行时间线：按轮次分组，外加计划变化与折叠的原始日志。 */
export function Timeline({ view }: { view: RunView }): ReactElement {
  return (
    <div className="timeline">
      {view.rounds.length === 0 ? <p className="muted">还没有模型轮次。</p> : null}
      {view.rounds.map((round) => (
        <Round key={round.step} round={round} />
      ))}

      <section className="plan-changes">
        <h3>计划变化</h3>
        {view.planChanges.length === 0 ? (
          <p className="muted">（本次运行没有修订过计划）</p>
        ) : (
          <ul>
            {view.planChanges.map((change, index) => (
              <li key={`plan-${index}`} data-testid={`plan-change-${index}`}>
                <div className="plan-head">
                  <span className="tag">version={change.version ?? "unknown"}</span>
                  <span>{change.reason}</span>
                </div>
                {change.detail === undefined ? null : (
                  <Collapsible title="计划差异 detail" summary={change.at}>
                    <pre className="mono">{formatJson(change.detail)}</pre>
                  </Collapsible>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <Collapsible title="原始事件 / 日志" summary={`${view.logLines.length} 行`} className="raw">
        <pre className="mono">{view.logLines.join("\n")}</pre>
      </Collapsible>
    </div>
  );
}
