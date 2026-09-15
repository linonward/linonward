import { readFileSync } from "node:fs";

import { z } from "zod";

import type { RunUsage } from "./trace.js";

/**
 * 估算成本：**版本化、可配置、未知即 `unknown`**。
 *
 * 三条硬规则：
 * 1. **绝不返回 0 冒充**。模型不在表里、或 `input` / `output` 用量未知，一律返回
 *    `undefined`，输出层显示 `cost=unknown`。
 * 2. 价格表带 `asOf` 与 `source`，并且可以整体被环境变量覆盖（见 `resolvePriceTable`）。
 * 3. 价格是**估算**：peak / off-peak、缓存口径、四舍五入都会让数字与账单不同，
 *    它只用来回答"这次运行大概是这个量级"，不是对账依据。
 */

/** 单个模型的单价（美元 / 1M token）。 */
export interface ModelPrice {
  inputPerMillionUsd: number;
  /** 缓存命中的输入单价。缺省表示该模型没有独立的缓存价，缓存部分并入 input 价。 */
  cachedInputPerMillionUsd?: number | undefined;
  outputPerMillionUsd: number;
  /** 这份价格的日期（文档快照日期），让"算出来的钱"可追溯。 */
  asOf: string;
}

/** 一张完整的价目表：版本化（`asOf`）+ 可追溯（`source`）。 */
export interface PriceTable {
  asOf: string;
  models: Record<string, ModelPrice>;
  source?: string | undefined;
}

/**
 * 内置价格表。
 *
 * 来源：DeepSeek 官方 "Models & Pricing"（文档镜像快照日期 `2026-08-23`）：
 * `https://api-docs.deepseek.com/quick_start/pricing`。
 *
 * 表里列的是 **peak 时段价格**：官方对每个价格都给了 peak / off-peak 两档，
 * off-peak 恰好是 peak 的一半。这里取 peak 作为**上界**（宁可高估不可低估），
 * 并把口径写进 `source`，输出里因此能直接看到这不是账单数字。
 *
 * 缓存命中价按官方 "1M INPUT TOKENS (CACHE HIT)" 列；`input_tokens` 是**总量**，
 * `cached_tokens` 是它的子集，因此计价时只对"未命中"的部分用 cache miss 价。
 */
export const BUILTIN_PRICE_TABLE: PriceTable = {
  asOf: "2026-08-23",
  source: "https://api-docs.deepseek.com/quick_start/pricing (peak rates; off-peak is half)",
  models: {
    "deepseek-v4-flash": {
      inputPerMillionUsd: 0.44,
      cachedInputPerMillionUsd: 0.014,
      outputPerMillionUsd: 1.32,
      asOf: "2026-08-23",
    },
    "deepseek-v4-pro": {
      inputPerMillionUsd: 1.32,
      cachedInputPerMillionUsd: 0.044,
      outputPerMillionUsd: 3.96,
      asOf: "2026-08-23",
    },
    "deepseek-v4-flash-vision-exp": {
      inputPerMillionUsd: 0.44,
      cachedInputPerMillionUsd: 0.014,
      outputPerMillionUsd: 1.32,
      asOf: "2026-08-23",
    },
  },
};

const modelPriceSchema = z
  .object({
    inputPerMillionUsd: z.number().nonnegative(),
    cachedInputPerMillionUsd: z.number().nonnegative().optional(),
    outputPerMillionUsd: z.number().nonnegative(),
    asOf: z.string().min(1),
  })
  .strict();

const priceTableSchema = z
  .object({
    asOf: z.string().min(1),
    models: z.record(z.string().min(1), modelPriceSchema),
    source: z.string().optional(),
  })
  .strict();

/** 内联 JSON 覆盖：`DEEPSEEK_PRICE_TABLE_JSON='{"asOf":...,"models":{...}}'`。 */
export const PRICE_TABLE_JSON_ENV = "DEEPSEEK_PRICE_TABLE_JSON";
/** 文件覆盖：`DEEPSEEK_PRICE_TABLE=/path/to/prices.json`。 */
export const PRICE_TABLE_PATH_ENV = "DEEPSEEK_PRICE_TABLE";

const TOKENS_PER_MILLION = 1_000_000;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 解析并校验一份价格表。失败时抛出**可读**错误（含字段路径），绝不静默退回内置表：
 * 静默回退会让"我以为我配了内部价"变成一组看起来正常、其实是别人的数字。
 */
export function parsePriceTable(text: string, origin: string): PriceTable {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${origin} 不是合法 JSON：${messageOf(error)}`);
  }

  const result = priceTableSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`${origin} 不是合法的价格表：${issues}`);
  }
  return result.data;
}

/**
 * 价格表来源优先级：`DEEPSEEK_PRICE_TABLE_JSON` → `DEEPSEEK_PRICE_TABLE` → 内置表。
 *
 * 两个环境变量都为空字符串时视为未设置（`.env` 里留空的常见写法）。
 */
export function resolvePriceTable(env: NodeJS.ProcessEnv = process.env): PriceTable {
  const inline = env[PRICE_TABLE_JSON_ENV];
  if (inline !== undefined && inline.trim().length > 0) {
    return parsePriceTable(inline, PRICE_TABLE_JSON_ENV);
  }

  const path = env[PRICE_TABLE_PATH_ENV];
  if (path !== undefined && path.trim().length > 0) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      throw new Error(`${PRICE_TABLE_PATH_ENV}=${path} 不可读：${messageOf(error)}`);
    }
    return parsePriceTable(text, `${PRICE_TABLE_PATH_ENV}=${path}`);
  }

  return BUILTIN_PRICE_TABLE;
}

/**
 * 估算一次运行的成本（美元）。
 *
 * 返回 `undefined` 的两种情况——**都不是 0**：
 * - 模型不在价目表里；
 * - `inputTokens` / `outputTokens` 未知（provider 没返回 usage）。
 *
 * 缓存口径：表里有独立缓存价且 `cachedInputTokens` 已知时，只对未命中的输入按
 * cache miss 价计费；表里没有缓存价时缓存部分并入 input 价（由 `describeCostBasis`
 * 在输出里注明）。`cachedInputTokens` 未知时按 **cache miss** 计（上界），同样有注明。
 */
export function estimateCostUsd(
  usage: RunUsage,
  modelId: string,
  table: PriceTable = BUILTIN_PRICE_TABLE,
): number | undefined {
  const price = table.models[modelId];
  if (price === undefined) return undefined;

  const inputTokens = usage.inputTokens;
  const outputTokens = usage.outputTokens;
  if (inputTokens === undefined || outputTokens === undefined) return undefined;

  const cachedInputPerMillionUsd = price.cachedInputPerMillionUsd;
  // `cached_tokens` 是 `input_tokens` 的子集；provider 口径异常时不让它把单价算成负数。
  const cachedTokens =
    cachedInputPerMillionUsd === undefined
      ? 0
      : Math.min(usage.cachedInputTokens ?? 0, inputTokens);

  const inputCostUsd =
    cachedInputPerMillionUsd === undefined
      ? (inputTokens * price.inputPerMillionUsd) / TOKENS_PER_MILLION
      : ((inputTokens - cachedTokens) * price.inputPerMillionUsd +
          cachedTokens * cachedInputPerMillionUsd) /
        TOKENS_PER_MILLION;
  const outputCostUsd = (outputTokens * price.outputPerMillionUsd) / TOKENS_PER_MILLION;

  return inputCostUsd + outputCostUsd;
}

/**
 * 计价口径的可读注解（`undefined` = 模型不在表里）。
 *
 * "cached 部分并入 input 价并注明"就落在这里：输出行会带上它，读者不必翻源码
 * 才知道缓存是不是被单独计价了。
 */
export function describeCostBasis(
  usage: RunUsage,
  modelId: string,
  table: PriceTable = BUILTIN_PRICE_TABLE,
): string | undefined {
  const price = table.models[modelId];
  if (price === undefined) return undefined;
  if (price.cachedInputPerMillionUsd === undefined) return "cache hits billed at input price";
  if (usage.cachedInputTokens === undefined) return "cache hits unknown, billed as misses";
  return "cache hits billed separately";
}

/** 成本显示：`undefined` → `unknown`（绝不显示 `$0.000000` 冒充免费）。 */
export function formatCostUsd(costUsd: number | undefined): string {
  return costUsd === undefined ? "unknown" : `$${costUsd.toFixed(6)}`;
}
