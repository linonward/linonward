import type { ComponentType } from "react";

export interface TableOfContentsItem {
  id: string;
  title: string;
}

export interface ChapterModule {
  default: ComponentType;
}

export const tutorialGoal =
  "通过逐章可运行的增量，理解 Agent 的模型、上下文、任务状态、规划、工具、Skills 与 Agent Loop 等关键组件，并从零构建一个由 Harness 约束、不依赖 Agent 框架的可用 Agent。";

export type ChapterTrack = "core" | "extension";

/**
 * 主线与扩展篇共用的章节契约。顺序、编号与轨道由各自模块的有序定义数组派生，
 * 不要再新增一份手写的顺序列表。
 */
export interface TutorialChapter {
  slug: string;
  number: string;
  track: ChapterTrack;
  title: string;
  label: string;
  minutes: number;
  description: string;
  toc: TableOfContentsItem[];
  load: () => Promise<ChapterModule>;
}

export interface Chapter extends TutorialChapter {
  track: "core";
}

export interface ExtensionChapter extends TutorialChapter {
  track: "extension";
  prerequisites: string;
}

/** 目录页与阅读壳层接受的可辨识联合：`track` 是判别字段。 */
export type AnyChapter = Chapter | ExtensionChapter;

export type ChapterDefinition = Omit<Chapter, "number" | "track">;
export type ExtensionChapterDefinition = Omit<ExtensionChapter, "number" | "track">;

export function numberChapter(index: number): string {
  return index.toString().padStart(2, "0");
}

/**
 * 主线的唯一事实源：数组顺序就是学习顺序，编号由下标派生。
 * 新增章节时只在这里插入，不要再维护第二份顺序数组。
 */
const coreChapterDefinitions: ChapterDefinition[] = [
  {
    slug: "start",
    title: "开始",
    label: "开始",
    minutes: 15,
    description: "理解逐章搭建路径，定义最终要交付的 Agent 与贯穿教程的工程边界。",
    toc: [
      { id: "understand-learning-path", title: "理解搭建路径" },
      { id: "verify-toolchain", title: "确认本地工具链" },
      { id: "create-project", title: "创建项目与依赖" },
      { id: "configure-project", title: "配置项目" },
      { id: "accept-first-task", title: "接收第一个任务" },
      { id: "define-finish-line", title: "写下完成标准" },
    ],
    load: () => import("../content/start.mdx"),
  },
  {
    slug: "model-call",
    title: "最小模型调用",
    label: "最小模型调用",
    minutes: 20,
    description: "建立可替换的模型接口，完成第一次结构化调用。",
    toc: [
      { id: "install-sdk", title: "安装 SDK" },
      { id: "configure-env", title: "配置本地环境" },
      { id: "call-model", title: "第一次 Responses API 调用" },
      { id: "extract-port", title: "抽出最小 Model 接口" },
      { id: "run-fake-model", title: "离线验证 Fake Model" },
    ],
    load: () => import("../content/model-call.mdx"),
  },
  {
    slug: "context-and-prompt",
    title: "上下文与系统 Prompt",
    label: "上下文与 Prompt",
    minutes: 35,
    description: "把规则、任务、环境资料与运行轨迹组装成可控的模型上下文。",
    toc: [
      { id: "separate-context-layers", title: "分清指令与数据" },
      { id: "write-system-prompt", title: "编写系统 Prompt" },
      { id: "model-context-sources", title: "标注上下文来源" },
      { id: "apply-context-budget", title: "应用上下文预算" },
      { id: "build-model-request", title: "组装模型请求" },
      { id: "inspect-context", title: "观测上下文" },
    ],
    load: () => import("../content/context-and-prompt.mdx"),
  },
  {
    slug: "agent-harness",
    title: "最小 Agent Loop",
    label: "最小 Agent Loop",
    minutes: 30,
    description: "先用最少状态和停止条件完成可观察、可取消的模型循环。",
    toc: [
      { id: "define-responsibilities", title: "划清 Harness 职责" },
      { id: "define-options", title: "定义 Harness 输入输出" },
      { id: "build-loop", title: "实现受控循环" },
      { id: "handle-failures", title: "统一处理失败" },
      { id: "wire-cli", title: "让 CLI 只负责装配" },
    ],
    load: () => import("../content/agent-harness.mdx"),
  },
  {
    slug: "tool-system",
    title: "工具系统",
    label: "工具系统",
    minutes: 50,
    description: "用统一、类型安全的协议把外部能力交给 Agent。",
    toc: [
      { id: "understand-tool-chain", title: "理解工具调用链" },
      { id: "define-tool", title: "从一个 Schema 定义工具" },
      { id: "build-registry", title: "生成模型工具列表" },
      { id: "parse-model-turn", title: "解析 function_call" },
      { id: "execute-call", title: "建立受控执行入口" },
      { id: "extend-loop", title: "提交工具结果" },
      { id: "test-tool-chain", title: "验证工具边界" },
    ],
    load: () => import("../content/tool-system.mdx"),
  },
  {
    slug: "understand-repository",
    title: "读懂仓库",
    label: "读懂仓库",
    minutes: 25,
    description: "提供受控的文件搜索与读取能力。",
    toc: [
      { id: "safe-path", title: "限制所有路径在工作区内" },
      { id: "read-file", title: "实现读取工具" },
      { id: "search-text", title: "实现搜索工具" },
      { id: "register-read-tools", title: "注册工具并收紧提示词" },
    ],
    load: () => import("../content/understand-repository.mdx"),
  },
  {
    slug: "edit-code",
    title: "修改代码",
    label: "修改代码",
    minutes: 35,
    description: "通过补丁完成可审查、可追踪的文件修改。",
    toc: [
      { id: "write-file", title: "带前置条件的写入工具" },
      { id: "track-files", title: "记录所有变更文件" },
      { id: "update-prompt", title: "要求模型先读再写" },
    ],
    load: () => import("../content/edit-code.mdx"),
  },
  {
    slug: "run-validation",
    title: "运行验证",
    label: "运行验证",
    minutes: 30,
    description: "让 Agent 用真实命令证明工作已经完成。",
    toc: [
      { id: "run-command", title: "无 Shell 的命令工具" },
      { id: "record-validation", title: "记录验证证据" },
      { id: "completion-gate", title: "加入完成门禁" },
    ],
    load: () => import("../content/run-validation.mdx"),
  },
  {
    slug: "task-state",
    title: "任务与状态",
    label: "任务与状态",
    minutes: 30,
    description: "把一句自然语言请求转换成可以持续推进的任务状态。",
    toc: [
      { id: "define-messages", title: "定义消息" },
      { id: "define-state", title: "定义状态" },
      { id: "initialize-state", title: "从 CLI 初始化状态" },
      { id: "enforce-transitions", title: "执行合法状态转换" },
      { id: "test-state-machine", title: "测试状态机路径" },
    ],
    load: () => import("../content/task-state.mdx"),
  },
  {
    slug: "permissions-safety",
    title: "权限与安全",
    label: "权限与安全",
    minutes: 35,
    description: "用策略层限制副作用，并在必要时请求人工确认。",
    toc: [
      { id: "risk-levels", title: "给工具标记风险等级" },
      { id: "authorize", title: "执行前应用授权策略" },
      { id: "final-run", title: "验收权限策略" },
    ],
    load: () => import("../content/permissions-safety.mdx"),
  },
  {
    slug: "task-planning",
    title: "任务分解与规划",
    label: "任务与规划",
    minutes: 75,
    description: "把用户目标拆成可执行步骤，用证据推进，并在计划失效时重规划。",
    toc: [
      { id: "plan-generation", title: "实验一：生成与校验" },
      { id: "plan-progress", title: "实验二：推进与重规划" },
      { id: "plan-verification", title: "实验三：测试与验收" },
    ],
    load: () => import("../content/task-planning.mdx"),
  },
  {
    slug: "user-interaction",
    title: "用户澄清与中途转向",
    label: "用户交互与转向",
    minutes: 40,
    description: "让 Agent 能提出问题、等待回答，并在用户改变目标时安全修订运行。",
    toc: [
      { id: "clarify-contract", title: "定义澄清契约" },
      { id: "persist-user-request", title: "持久化等待请求" },
      { id: "resume-with-input", title: "用用户输入恢复" },
      { id: "steer-active-run", title: "处理中途转向" },
      { id: "test-interaction", title: "测试交互状态机" },
    ],
    load: () => import("../content/user-interaction.mdx"),
  },
  {
    slug: "progressive-skills",
    title: "Skills 渐进式加载",
    label: "Skills 渐进加载",
    minutes: 60,
    description: "先发现能力，再加载指令，最后按需读取资源，避免上下文被无关内容占满。",
    toc: [
      { id: "define-skill-levels", title: "定义三层加载模型" },
      { id: "define-skill-contract", title: "定义 Skill 契约" },
      { id: "scan-skill-metadata", title: "只扫描元数据" },
      { id: "select-and-load-skill", title: "选择并加载 Skill" },
      { id: "load-skill-resource", title: "按需读取 Skill 资源" },
      { id: "connect-skills-to-loop", title: "接入 Agent Loop" },
      { id: "test-progressive-loading", title: "测试渐进式加载" },
    ],
    load: () => import("../content/progressive-skills.mdx"),
  },
  {
    slug: "observability-evaluation",
    title: "可观测性与评测",
    label: "可观测性与评测",
    minutes: 55,
    description: "用结构化 Trace、任务数据集和回归门禁衡量 Agent 是否真的变好。",
    toc: [
      { id: "define-trace", title: "定义 Trace 契约" },
      { id: "record-usage", title: "记录用量与延迟" },
      { id: "build-eval-suite", title: "建立任务评测集" },
      { id: "grade-outcomes", title: "分层判定结果" },
      { id: "regression-gate", title: "建立回归门禁" },
    ],
    load: () => import("../content/observability-evaluation.mdx"),
  },
  {
    slug: "agent-loop",
    title: "实现 Agent Loop",
    label: "Agent Loop",
    minutes: 75,
    description: "把上下文、模型、工具和停止策略连接成真正可运行的循环。",
    toc: [
      { id: "define-invariants", title: "定义循环不变量" },
      { id: "define-loop-contract", title: "定义循环契约" },
      { id: "read-one-iteration", title: "读懂单轮状态转换" },
      { id: "implement-complete-loop", title: "实现完整 Agent Loop" },
      { id: "trace-one-run", title: "追踪完整运行" },
      { id: "test-loop", title: "测试循环而非模型" },
    ],
    load: () => import("../content/agent-loop.mdx"),
  },
  {
    slug: "context-compaction",
    title: "上下文压缩",
    label: "上下文压缩",
    minutes: 60,
    description: "在不丢失目标、约束和证据的前提下，为长对话释放上下文空间。",
    toc: [
      { id: "define-compaction-contract", title: "定义压缩契约" },
      { id: "choose-compaction-boundary", title: "选择压缩时机" },
      { id: "build-compaction-snapshot", title: "生成结构化快照" },
      { id: "validate-compaction", title: "验证压缩结果" },
      { id: "replace-history-with-snapshot", title: "替换历史上下文" },
      { id: "connect-compaction-to-loop", title: "接入 Agent Loop" },
      { id: "test-compaction", title: "测试信息保真" },
    ],
    load: () => import("../content/context-compaction.mdx"),
  },
  {
    slug: "long-running-recovery",
    title: "长程任务恢复",
    label: "长程任务恢复",
    minutes: 65,
    description: "通过事件日志、原子检查点和幂等工具语义，让中断任务安全续跑。",
    toc: [
      { id: "separate-runtime-and-durable-state", title: "区分运行时与持久状态" },
      { id: "define-recovery-records", title: "定义恢复记录" },
      { id: "write-atomic-checkpoints", title: "写入原子检查点" },
      { id: "record-tool-intents", title: "记录工具意图与结果" },
      { id: "restore-and-replay", title: "恢复并重放事件" },
      { id: "resume-agent-loop", title: "续跑 Agent Loop" },
      { id: "test-crash-recovery", title: "测试崩溃恢复" },
    ],
    load: () => import("../content/long-running-recovery.mdx"),
  },
  {
    slug: "capstone",
    title: "综合 Capstone",
    label: "综合 Capstone",
    minutes: 75,
    description: "用任务矩阵和故障注入验收完整 Agent，而不是只跑一条成功路径。",
    toc: [
      { id: "define-matrix", title: "定义任务矩阵" },
      { id: "run-capstone", title: "完成真实工程任务" },
      { id: "inject-failures", title: "执行故障注入" },
      { id: "review-evidence", title: "审查完成证据" },
    ],
    load: () => import("../content/capstone.mdx"),
  },
];

export const chapters: Chapter[] = coreChapterDefinitions.map((definition, index) => ({
  ...definition,
  number: numberChapter(index),
  track: "core",
}));

export function getChapter(slug: string): Chapter | undefined {
  return chapters.find((chapter) => chapter.slug === slug);
}

export function getChapterNeighbors(slug: string): {
  previous: Chapter | undefined;
  next: Chapter | undefined;
} {
  const index = chapters.findIndex((chapter) => chapter.slug === slug);

  if (index === -1) {
    return { previous: undefined, next: undefined };
  }

  return {
    previous: chapters[index - 1],
    next: chapters[index + 1],
  };
}

export function totalMinutes(items: readonly { minutes: number }[]): number {
  return items.reduce((sum, item) => sum + item.minutes, 0);
}
