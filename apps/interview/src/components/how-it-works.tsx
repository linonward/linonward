export function HowItWorks() {
  const steps = [
    ["1", "提交资料", "提交技术岗社招的目标公司、方向、JD、简历和面试轮次。"],
    [
      "2",
      "资料分析 + 人工校验",
      "结合你的背景、岗位要求与面试轮次，由人工校验后整理为专属面试作战包。",
    ],
    ["3", "面后复盘", "面试结束后回填真实题目、命中情况和卡点，帮助下一轮准备。"],
  ];
  return (
    <section className="section steps">
      <div className="shell">
        <h2>只需要 3 步</h2>
        <div className="steps-grid">
          {steps.map(([num, title, description]) => (
            <article key={num}>
              <span>{num}</span>
              <h3>
                <mark className="marker marker-blue">{title}</mark>
              </h3>
              <p>{description}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
