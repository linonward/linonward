import type { Dirent } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * 运行目录的保留策略。
 *
 * `LocalFileRunStore` 每次运行都会留下检查点、事件日志与 journal，而且**只增不减**。
 * 生产环境必须能按保留期清理；清理本身也要可解释：删了哪些、留下多少，都要能被打印出来。
 *
 * 年龄取"目录内容里最新的 mtime"：正在跑或刚跑完的运行一定是新的，不会被误删。
 */

export const RETENTION_DAYS_ENV = "AGENT_RETENTION_DAYS";
export const DAY_MS = 24 * 60 * 60 * 1_000;

export interface PruneRunsOptions {
  maxAgeMs: number;
  now?: Date | undefined;
  /** 只报告不删除（先看会发生什么）。 */
  dryRun?: boolean | undefined;
}

export interface PruneRunsResult {
  removed: string[];
  kept: number;
  dryRun: boolean;
}

/** `AGENT_RETENTION_DAYS`：缺省不清理；非法值直接报错，不静默退回"不清理"。 */
export function parseRetentionDays(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env[RETENTION_DAYS_ENV];
  if (raw === undefined || raw.trim().length === 0) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${RETENTION_DAYS_ENV} 需要非负整数（天），收到：${raw}`);
  }
  return parsed;
}

/** 目录里最新的 mtime；读不到任何条目时返回 `undefined`（无法判断年龄）。 */
async function newestMtimeMs(directory: string): Promise<number | undefined> {
  let newest: number | undefined;

  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await newestMtimeMs(path);
      if (nested !== undefined && (newest === undefined || nested > newest)) newest = nested;
      continue;
    }
    try {
      const info = await stat(path);
      if (newest === undefined || info.mtimeMs > newest) newest = info.mtimeMs;
    } catch {
      // 并发删除等情况下跳过这一条，不因此让整次清理失败。
      continue;
    }
  }

  return newest;
}

/**
 * 按保留期清理运行目录。
 *
 * 只处理**目录**（根目录下的普通文件不是运行）；单个目录读不出来就跳过它自己，
 * 不影响其它运行。
 */
export async function pruneRuns(root: string, options: PruneRunsOptions): Promise<PruneRunsResult> {
  const now = options.now ?? new Date();
  const dryRun = options.dryRun === true;
  const removed: string[] = [];
  let kept = 0;

  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return { removed, kept, dryRun };
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const directory = join(root, entry.name);

    let newest: number | undefined;
    try {
      newest = await newestMtimeMs(directory);
    } catch {
      kept += 1;
      continue;
    }
    // 读不出 mtime 时按"保留"处理：清理不能建立在猜测上。
    if (newest === undefined || now.getTime() - newest < options.maxAgeMs) {
      kept += 1;
      continue;
    }

    if (!dryRun) await rm(directory, { recursive: true, force: true });
    removed.push(entry.name);
  }

  removed.sort();
  return { removed, kept, dryRun };
}
