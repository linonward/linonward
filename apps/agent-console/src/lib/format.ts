/** 展示层格式化：**未知就是 unknown**，绝不用 0 或空串冒充。 */

export function formatCount(value: number | undefined): string {
  return value === undefined ? "unknown" : value.toLocaleString("en-US");
}

export function formatCost(costUsd: number | undefined, costKnown: boolean): string {
  if (!costKnown || costUsd === undefined) return "unknown";
  return `$${costUsd.toFixed(6)}`;
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return "unknown";
  if (ms < 1_000) return `${ms}ms`;
  return `${(ms / 1_000).toFixed(2)}s`;
}

/** 折叠块的摘要行：行数 + 字符数，让"要不要展开"可以先判断。 */
export function summarizeText(text: string): string {
  if (text.length === 0) return "空 · 0 字符";
  const lines = text.split("\n").length;
  return `${lines} 行 · ${text.length.toLocaleString("en-US")} 字符`;
}

export function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
