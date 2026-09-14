import type { ComponentType } from "react";

export interface TableOfContentsItem {
  id: string;
  title: string;
}

interface ChapterModule {
  default: ComponentType;
}

export interface Chapter {
  slug: string;
  number: string;
  title: string;
  label: string;
  description: string;
  toc: TableOfContentsItem[];
  load: () => Promise<ChapterModule>;
}

export const chapters: Chapter[] = [
  {
    slug: "start",
    number: "00",
    title: "开始",
    label: "开始",
    description: "定义最终要交付的 Agent，以及贯穿教程的工程边界。",
    toc: [
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
    number: "01",
    title: "最小模型调用",
    label: "最小模型调用",
    description: "建立可替换的模型接口，完成第一次结构化调用。",
    toc: [
      { id: "install-sdk", title: "安装 SDK" },
      { id: "configure-env", title: "配置本地环境" },
      { id: "call-model", title: "第一次 Responses API 调用" },
      { id: "extract-port", title: "抽出最小 Model 接口" },
    ],
    load: () => import("../content/model-call.mdx"),
  },
  {
    slug: "context-and-prompt",
    number: "02",
    title: "上下文与系统 Prompt",
    label: "上下文与 Prompt",
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
    slug: "task-state",
    number: "03",
    title: "任务与状态",
    label: "任务与状态",
    description: "把一句自然语言请求转换成可以持续推进的任务状态。",
    toc: [
      { id: "define-messages", title: "定义消息" },
      { id: "define-state", title: "定义状态" },
      { id: "initialize-state", title: "从 CLI 初始化状态" },
    ],
    load: () => import("../content/task-state.mdx"),
  },
  {
    slug: "task-planning",
    number: "04",
    title: "任务分解与规划",
    label: "任务与规划",
    description: "把用户目标拆成可执行步骤，用证据推进，并在计划失效时重规划。",
    toc: [
      { id: "separate-goal-plan-step", title: "区分目标、计划与步骤" },
      { id: "define-plan-state", title: "定义计划状态" },
      { id: "create-initial-plan", title: "生成并校验初始计划" },
      { id: "advance-plan", title: "按依赖推进步骤" },
      { id: "replan-from-evidence", title: "基于证据重规划" },
      { id: "connect-plan-to-loop", title: "把计划接入 Loop" },
      { id: "test-planning", title: "测试计划状态机" },
    ],
    load: () => import("../content/task-planning.mdx"),
  },
  {
    slug: "agent-harness",
    number: "05",
    title: "构建 Agent Harness",
    label: "Agent Harness",
    description: "模型负责决策，Harness 负责让任务安全、可靠地完成。",
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
    number: "06",
    title: "工具系统",
    label: "工具系统",
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
    slug: "progressive-skills",
    number: "07",
    title: "Skills 渐进式加载",
    label: "Skills 渐进加载",
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
    slug: "agent-loop",
    number: "08",
    title: "实现 Agent Loop",
    label: "Agent Loop",
    description: "把上下文、模型、工具和停止策略连接成真正可运行的循环。",
    toc: [
      { id: "define-invariants", title: "定义循环不变量" },
      { id: "define-loop-contract", title: "定义循环契约" },
      { id: "read-one-iteration", title: "读懂单轮状态转换" },
      { id: "implement-complete-loop", title: "实现完整 Agent Loop" },
      { id: "trace-one-run", title: "追踪一次真实运行" },
      { id: "test-loop", title: "测试循环而非模型" },
    ],
    load: () => import("../content/agent-loop.mdx"),
  },
  {
    slug: "context-compaction",
    number: "09",
    title: "上下文压缩",
    label: "上下文压缩",
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
    number: "10",
    title: "长程任务恢复",
    label: "长程任务恢复",
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
    slug: "understand-repository",
    number: "11",
    title: "读懂仓库",
    label: "读懂仓库",
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
    number: "12",
    title: "修改代码",
    label: "修改代码",
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
    number: "13",
    title: "运行验证",
    label: "运行验证",
    description: "让 Agent 用真实命令证明工作已经完成。",
    toc: [
      { id: "run-command", title: "无 Shell 的命令工具" },
      { id: "record-validation", title: "记录验证证据" },
      { id: "completion-gate", title: "加入完成门禁" },
    ],
    load: () => import("../content/run-validation.mdx"),
  },
  {
    slug: "permissions-safety",
    number: "14",
    title: "权限与安全",
    label: "权限与安全",
    description: "用策略层限制副作用，并在必要时请求人工确认。",
    toc: [
      { id: "risk-levels", title: "给工具标记风险等级" },
      { id: "authorize", title: "执行前应用授权策略" },
      { id: "final-run", title: "完成真实任务" },
    ],
    load: () => import("../content/permissions-safety.mdx"),
  },
];

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
