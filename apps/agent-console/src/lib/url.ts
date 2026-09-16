/**
 * `runId` 与地址栏的双向映射。
 *
 * 运行完全由 SSE 驱动，而 `runId` 只活在 React state 里——刷新一次就再也找不回来。
 * 把它放进 `?run=<id>` 查询参数（而不是路径）有两个好处：不需要 SPA 回退规则，
 * 且不干扰将来的其它筛选参数。
 *
 * 这两个函数是纯字符串函数，因此可以在 node 环境里直接测，不需要 jsdom。
 */

export const RUN_QUERY_KEY = "run";

/** 读出 `?run=<id>`；缺失或被空白污染时返回 `undefined`。 */
export function readRunId(search: string): string | undefined {
  const value = new URLSearchParams(search).get(RUN_QUERY_KEY);
  const runId = value?.trim();
  return runId === undefined || runId.length === 0 ? undefined : runId;
}

/** 写入 / 清除 `?run=<id>`，其它查询参数原样保留；没有参数时返回空串。 */
export function withRunId(search: string, runId: string | undefined): string {
  const params = new URLSearchParams(search);
  if (runId === undefined) params.delete(RUN_QUERY_KEY);
  else params.set(RUN_QUERY_KEY, runId);

  const query = params.toString();
  return query.length === 0 ? "" : `?${query}`;
}
