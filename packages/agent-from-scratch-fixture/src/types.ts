import type { ContextSource } from "./context.js";

/**
 * 可以注入的时钟。教程里所有需要“现在”的地方都接受它，
 * 这样测试可以固定时间，生产代码默认使用系统时间。
 */
export interface Clock {
  now(): Date;
}

export interface AgentMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AgentStep {
  number: number;
  kind: "model" | "tool";
  summary: string;
}

export interface AgentEvent {
  eventId: string;
  sequence: number;
  recordedAt: string;
  type: string;
  detail: string;
}

export interface AgentBudget {
  maxSteps: number;
  maxToolCalls: number;
  modelSteps: number;
  toolCalls: number;
}

/**
 * 停止原因是受测试约束的稳定注册表，而不是每章重新声明一个不兼容的联合类型。
 * 后续章节只在这里追加键。
 */
export interface StopReasonMap {
  final_answer: true;
  max_steps: true;
  max_tool_calls: true;
  cancelled: true;
  model_error: true;
  invalid_model_output: true;
  approval_required: true;
  user_input_required: true;
  blocked_plan: true;
  interrupted: true;
  /** 压缩连续校验失败导致的停止：宁可停下，也不用"差不多"的摘要继续。 */
  compaction_failed: true;
}

export type StopReason = keyof StopReasonMap;

export interface ValidationRecord {
  id: string;
  command: string;
  args: string[];
  exitCode: number;
  durationMs: number;
  status: "passed" | "failed";
  validatedRevision: number;
  changedFileHashes: Record<string, string>;
  criterionIds: string[];
}

/** Harness 只从验证规格创建命令，模型不能把任意成功命令自行标成证据。 */
export interface ValidationSpec {
  command: string;
  args: string[];
  criterionIds: string[];
}

export interface AcceptanceCriterion {
  id: string;
  description: string;
  status: "unverified" | "passed" | "failed";
  evidence?: string | undefined;
}

export interface PlanStep {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "blocked";
  dependsOn: string[];
  completionEvidence: string;
  evidence: string[];
}

export interface TaskPlan {
  version: number;
  goal: string;
  acceptanceCriteria: AcceptanceCriterion[];
  steps: PlanStep[];
  revisionReason?: string | undefined;
}

export interface PlanHistoryEntry {
  version: number;
  reason: string;
  changedAt: string;
}

export interface SkillSummary {
  name: string;
  description: string;
  root: string;
  entryPath: string;
}

export interface ActiveSkill {
  name: string;
  instructions: string;
  loadedResources: Record<string, string>;
}

export interface SkillState {
  catalog: SkillSummary[];
  activeSkills: Record<string, ActiveSkill>;
}

export interface UserInputRequest {
  id: string;
  kind: "clarification" | "approval" | "manual_reconciliation";
  question: string;
  reason: string;
  relatedStepId?: string | undefined;
  createdAt: string;
  expiresAt?: string | undefined;
}

export interface UserInputAnswer {
  requestId: string;
  content: string;
  receivedAt: string;
}

export interface CompactionSnapshot {
  id: string;
  createdAt: string;
  sourceEventRange: { from: number; to: number };
  goal: string;
  constraints: string[];
  decisions: Array<{ statement: string; evidenceEventIds: string[] }>;
  completedWork: Array<{ stepId: string; evidence: string[] }>;
  pendingWork: Array<{ stepId: string; reason: string }>;
  acceptanceCriteria: AcceptanceCriterion[];
  activeSkills: string[];
  changedFiles: string[];
  validationResults: ValidationRecord[];
  unresolvedQuestions: string[];
  failedAttempts: string[];
  checksum: string;
}

export interface CompactionState {
  snapshots: CompactionSnapshot[];
  compactedThroughEvent: number;
  providerItems?: unknown[] | undefined;
}

/** 一条可以持久化的事件输入（payload 由各章节自行定义）。 */
export interface AgentEventInput {
  type: string;
  [key: string]: unknown;
}

export interface AgentState {
  runId: string;
  task: string;
  cwd: string;
  status: "running" | "waiting" | "completed" | "failed" | "blocked" | "cancelled";
  messages: AgentMessage[];
  contextSources: ContextSource[];
  steps: AgentStep[];
  changedFiles: string[];
  changedFileHashes: Record<string, string>;
  mutationRevision: number;
  validations: ValidationRecord[];
  requiredCriterionIds: string[];
  failedAttempts: string[];
  budget: AgentBudget;
  events: AgentEvent[];
  nextEventSequence: number;
  stopReason: string | undefined;
  plan: TaskPlan | undefined;
  activeStepId: string | undefined;
  planHistory: PlanHistoryEntry[];
  pendingUserInput: UserInputRequest | undefined;
  goalVersion: number;
  constraints: string[];
  skills: SkillState;
  compaction: CompactionState;
}

export interface AgentResult {
  status: AgentState["status"];
  answer: string;
  stopReason: StopReason;
  state: AgentState;
}

/** 持久化时只保留可序列化的投影，函数与句柄一律重新注入。 */
export interface PersistedContextSource {
  id: string;
  kind: string;
  label: string;
  content: string;
  priority: number;
}

export interface PersistedSkillState {
  catalog: SkillSummary[];
  activeSkills: Record<string, ActiveSkill>;
}

export interface ProviderCursor {
  provider: string;
  model: string;
  previousResponseId: string;
}

export interface DurableAgentState {
  runId: string;
  task: string;
  cwd: string;
  status: AgentState["status"];
  plan: TaskPlan;
  activeStepId?: string | undefined;
  planHistory: PlanHistoryEntry[];
  messages: AgentMessage[];
  contextSources: PersistedContextSource[];
  skills: PersistedSkillState;
  compaction: CompactionState;
  changedFiles: string[];
  changedFileHashes: Record<string, string>;
  mutationRevision: number;
  validations: ValidationRecord[];
  requiredCriterionIds: string[];
  budget: AgentBudget;
  pendingUserInput?: UserInputRequest | undefined;
  goalVersion: number;
  constraints: string[];
  failedAttempts: string[];
  events: AgentEvent[];
  nextEventSequence: number;
  stopReason: string | undefined;
  providerCursor?: ProviderCursor | undefined;
}
