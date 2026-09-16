import { type ReactElement, useState } from "react";

/**
 * 回答等待中的请求（审批 / 澄清）。
 *
 * 抽成独立组件的原因：这个输入框有两个数据来源——实时流里的 `waiting` 工具结果，
 * 以及刷新后从 checkpoint 快照里读回的 `pending`。两处必须渲染成同一个东西，
 * 否则"刷新前能答、刷新后答不了"就会变成两个实现各自漂移的 bug。
 */
export function AnswerBox({
  requestId,
  question,
  reason,
  onAnswer,
}: {
  requestId: string;
  question?: string | undefined;
  reason: string;
  onAnswer(input: { requestId: string; text: string }): void;
}): ReactElement {
  const [text, setText] = useState("");
  return (
    <form
      className="answer"
      data-testid="answer-box"
      onSubmit={(event) => {
        event.preventDefault();
        if (text.trim().length === 0) return;
        onAnswer({ requestId, text: text.trim() });
        setText("");
      }}
    >
      <strong>需要回答（requestId={requestId}）</strong>
      {question === undefined || question.length === 0 ? null : (
        <p className="muted small">{question}</p>
      )}
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
