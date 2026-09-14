const steps = [
  ["Task", "明确目标"],
  ["Model", "选择动作"],
  ["Tool", "受控执行"],
  ["Observation", "返回结果"],
  ["Model", "继续或结束"],
] as const;

export function AgentFlow() {
  return (
    <div aria-label="Agent 核心运行循环" className="agent-flow" role="img">
      {steps.map(([title, description], index) => (
        <div className="agent-flow__item" key={`${title}-${description}`}>
          <div className="agent-flow__step">
            <strong>{title}</strong>
            <span>{description}</span>
          </div>
          {index < steps.length - 1 ? (
            <span aria-hidden="true" className="agent-flow__arrow">
              →
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}
