const phases = [
  ["1", "Assemble", "组装本轮上下文"],
  ["2", "Decide", "模型返回文本或调用"],
  ["3", "Act", "校验并执行工具"],
  ["4", "Observe", "记录结构化结果"],
] as const;

export function AgentLoopDiagram() {
  return (
    <div
      aria-label="Agent Loop：组装上下文、模型决策、执行工具、记录观察，然后继续或停止"
      className="loop-diagram"
      role="img"
    >
      <div className="loop-diagram__cycle">
        {phases.map(([number, title, description], index) => (
          <div className="loop-diagram__phase-wrap" key={title}>
            <div className="loop-diagram__phase">
              <span>{number}</span>
              <strong>{title}</strong>
              <small>{description}</small>
            </div>
            {index < phases.length - 1 ? <b aria-hidden="true">→</b> : null}
          </div>
        ))}
      </div>
      <div className="loop-diagram__branches">
        <div>
          <span>有工具调用</span>
          <strong>↺ observation 回到下一轮</strong>
        </div>
        <div>
          <span>无工具调用</span>
          <strong>最终文本 → 完成</strong>
        </div>
        <div>
          <span>预算 / 取消 / 无效输出</span>
          <strong>停止并返回原因</strong>
        </div>
      </div>
    </div>
  );
}
