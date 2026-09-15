import { type ExtensionChapter, type ExtensionChapterDefinition, numberChapter } from "./chapters";

/**
 * 扩展篇的唯一事实源。数组顺序就是推荐阅读顺序，编号由下标派生。
 *
 * 扩展篇复用主线建立的 Model、Context、Tool、Policy、State、Trace 与 Eval 边界，
 * 但不是主线 Capstone 的前置条件：任何一章扩展内容都不得被主线章节引用为必需步骤。
 */
const extensionChapterDefinitions: ExtensionChapterDefinition[] = [
  {
    slug: "multi-agent",
    title: "多 Agent 协作",
    label: "多 Agent 协作",
    minutes: 70,
    description: "在单 Agent 边界稳定后，增加角色分工、任务交接和结果归并。",
    prerequisites: "主线 04 工具系统、09 权限与安全、14 Agent Loop 已经通过 Checkpoint。",
    toc: [
      { id: "define-role-contract", title: "定义角色与交接契约" },
      { id: "persist-handoff", title: "持久化交接任务" },
      { id: "run-subagent", title: "运行子 Agent 并继承预算" },
      { id: "merge-results", title: "确定性归并与冲突处理" },
      { id: "test-handoff", title: "测试交接与归并" },
    ],
    load: () => import("../content/extensions/multi-agent.mdx"),
  },
  {
    slug: "mcp",
    title: "MCP 集成",
    label: "MCP 集成",
    minutes: 60,
    description: "把外部 MCP Server 适配到已有的工具、资源、权限和审计边界。",
    prerequisites: "主线 04 工具系统与 09 权限与安全已经通过 Checkpoint。",
    toc: [
      { id: "define-transport", title: "定义传输边界" },
      { id: "discover-capabilities", title: "发现并映射能力" },
      { id: "validate-schemas", title: "转换并校验参数" },
      { id: "apply-policy", title: "复用权限与沙箱" },
      { id: "manage-lifecycle", title: "管理生命周期与取消" },
      { id: "test-mcp", title: "用 Fake Transport 验证" },
    ],
    load: () => import("../content/extensions/mcp.mdx"),
  },
  {
    slug: "rag",
    title: "RAG 与知识库",
    label: "RAG 与知识库",
    minutes: 65,
    description: "增加切分、索引、检索、引用和检索质量评测。",
    prerequisites: "主线 02 上下文与 Prompt、13 可观测性与评测已经通过 Checkpoint。",
    toc: [
      { id: "define-document-contract", title: "定义文档与切分契约" },
      { id: "build-index", title: "建立可增量更新的索引" },
      { id: "retrieve-and-inject", title: "检索并注入上下文" },
      { id: "enforce-citations", title: "强制引用来源" },
      { id: "evaluate-retrieval", title: "评测检索与引用质量" },
    ],
    load: () => import("../content/extensions/rag.mdx"),
  },
  {
    slug: "browser-automation",
    title: "浏览器操作",
    label: "浏览器操作",
    minutes: 60,
    description: "把页面观测、交互、会话和高风险动作并入 Harness 约束。",
    prerequisites: "主线 05 读懂仓库、09 权限与安全已经通过 Checkpoint。",
    toc: [
      { id: "define-observation-contract", title: "定义观测与动作契约" },
      { id: "manage-session", title: "管理会话与凭据边界" },
      { id: "resolve-element-refs", title: "处理元素引用失效" },
      { id: "gate-risky-actions", title: "为高风险动作加门禁" },
      { id: "test-browser", title: "用 Fake Session 验证" },
    ],
    load: () => import("../content/extensions/browser-automation.mdx"),
  },
  {
    slug: "voice",
    title: "语音 Agent",
    label: "语音 Agent",
    minutes: 55,
    description: "处理实时输入输出、打断、转录、延迟和会话状态。",
    prerequisites: "主线 11 用户澄清与中途转向、14 Agent Loop 已经通过 Checkpoint。",
    toc: [
      { id: "define-voice-session", title: "定义会话与事件契约" },
      { id: "stream-and-transcribe", title: "流式输入与转录" },
      { id: "handle-barge-in", title: "处理打断与取消" },
      { id: "budget-latency", title: "约束延迟预算" },
      { id: "test-voice", title: "测试状态与取消" },
    ],
    load: () => import("../content/extensions/voice.mdx"),
  },
  {
    slug: "parallel-orchestration",
    title: "复杂并行调度",
    label: "复杂并行调度",
    minutes: 70,
    description: "在可证明独立的工作上引入并行、背压、取消、部分失败和确定性归并。",
    prerequisites: "主线 10 任务分解与规划、16 长程任务恢复已经通过 Checkpoint。",
    toc: [
      { id: "prove-independence", title: "证明任务确实独立" },
      { id: "compute-ready-layers", title: "计算并行层" },
      { id: "bound-concurrency", title: "并发上限与背压" },
      { id: "propagate-cancellation", title: "传播取消与部分失败" },
      { id: "merge-deterministically", title: "确定性归并" },
      { id: "test-schedule", title: "测试调度不变量" },
    ],
    load: () => import("../content/extensions/parallel-orchestration.mdx"),
  },
];

export const extensionChapters: ExtensionChapter[] = extensionChapterDefinitions.map(
  (definition, index) => ({
    ...definition,
    number: `E${numberChapter(index + 1)}`,
    track: "extension",
  }),
);

export interface TutorialExtension {
  id: string;
  title: string;
  description: string;
}

/** 站内导航与摘要使用的轻量视图，与章节注册表保持同一事实源。 */
export const tutorialExtensions: TutorialExtension[] = extensionChapters.map((chapter) => ({
  id: chapter.slug,
  title: chapter.title,
  description: chapter.description,
}));

export function getExtensionChapter(slug: string): ExtensionChapter | undefined {
  return extensionChapters.find((chapter) => chapter.slug === slug);
}

export function getExtensionNeighbors(slug: string): {
  previous: ExtensionChapter | undefined;
  next: ExtensionChapter | undefined;
} {
  const index = extensionChapters.findIndex((chapter) => chapter.slug === slug);

  if (index === -1) {
    return { previous: undefined, next: undefined };
  }

  return {
    previous: extensionChapters[index - 1],
    next: extensionChapters[index + 1],
  };
}
