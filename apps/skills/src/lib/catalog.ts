export type SkillStage = {
  order: number;
  stage: string;
  slug: string;
  title: string;
  summary: string;
};

export const SKILL_STAGES = [
  {
    order: 1,
    stage: "定义",
    slug: "shape-work",
    title: "Shape Work",
    summary: "把模糊请求压缩为可验证的目标、边界与完成条件。",
  },
  {
    order: 2,
    stage: "取舍",
    slug: "cut-scope",
    title: "Cut Scope",
    summary: "切出最小完整交付，明确本轮不做什么。",
  },
  {
    order: 3,
    stage: "计划",
    slug: "challenge-plan",
    title: "Challenge Plan",
    summary: "在编码前，从价值、架构、数据与运维角度挑战计划。",
  },
  {
    order: 4,
    stage: "实现",
    slug: "trace-failure",
    title: "Trace Failure",
    summary: "建立可靠证据链，定位根因后再修复。",
  },
  {
    order: 5,
    stage: "验收",
    slug: "prove-behavior",
    title: "Prove Behavior",
    summary: "从用户路径出发，用运行证据证明结果可用。",
  },
  {
    order: 6,
    stage: "评审",
    slug: "inspect-change",
    title: "Inspect Change",
    summary: "按实际风险审查变更，输出有证据、可执行的发现。",
  },
  {
    order: 7,
    stage: "文档",
    slug: "align-docs",
    title: "Align Docs",
    summary: "根据真实改动同步权威文档，避免说明与实现漂移。",
  },
  {
    order: 8,
    stage: "交接",
    slug: "carry-context",
    title: "Carry Context",
    summary: "把当前状态压缩成下一位执行者能继续工作的交接包。",
  },
] as const satisfies readonly SkillStage[];

export const SKILL_STAGE_BY_SLUG: ReadonlyMap<string, SkillStage> = new Map<string, SkillStage>(
  SKILL_STAGES.map((skill) => [skill.slug, skill]),
);
