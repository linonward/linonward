import {
  CircleHelp,
  Clock3,
  FileQuestion,
  Lightbulb,
  MessageSquareText,
  Target,
  type LucideIcon,
} from "lucide-react";

type IconItem = readonly [string, string, LucideIcon];
type BenefitItem = readonly [string, string, string, LucideIcon];

const pains: IconItem[] = [
  ["不知道考什么", "JD 里技术点太多，不清楚面试官会重点问哪些。", Target],
  ["不会怎么答", "知道概念，但组织不好语言，答不到点子上。", CircleHelp],
  ["没时间系统准备", "临时抱佛脚，效率低，越准备越焦虑。", Clock3],
];

const benefits: BenefitItem[] = [
  ["01", "最可能被问的 10 个问题", "结合 JD 与项目经历，筛出最值得优先准备的问题。", FileQuestion],
  ["02", "可以直接说出口的答案", "按你的经历组织表达，减少临场卡壳。", MessageSquareText],
  ["03", "面试官下一层追问", "提前拆解“为什么、收益、落地、复盘”等连续追问。", Lightbulb],
  ["04", "项目最危险的薄弱点", "提前暴露项目中容易被深挖、说不清的地方。", Target],
  ["05", "面试前 2 小时冲刺计划", "按时间优先级安排最后两小时，知道先练什么。", Clock3],
  ["06", "3–5 个高质量反问", "准备能判断岗位与团队的高质量问题。", CircleHelp],
];
export function Benefits() {
  return (
    <>
      <section className="section">
        <div className="shell">
          <h2>
            面试<mark className="marker">最怕</mark>的不是不会，而是不知道该准备什么
          </h2>
          <div className="pain-grid">
            {pains.map(([title, text, Icon]) => (
              <article key={title}>
                <span className="pain-icon">
                  <Icon aria-hidden="true" />
                </span>
                <div>
                  <h3>{title}</h3>
                  <p>{text}</p>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>
      <section className="section benefits">
        <div className="shell">
          <h2>
            一份 <span className="circle-tag">Interview Pack</span> 包含什么？
          </h2>
          <div className="benefit-grid">
            {benefits.map(([number, title, text, Icon]) => (
              <article key={number}>
                <span className="benefit-icon">
                  <Icon aria-hidden="true" />
                </span>
                <div>
                  <h3>
                    {number.replace("0", "")}. {title}
                  </h3>
                  <p>{text}</p>
                </div>
              </article>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
