import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BUILTIN_PRICE_TABLE,
  describeCostBasis,
  estimateCostUsd,
  formatCostUsd,
  PRICE_TABLE_JSON_ENV,
  PRICE_TABLE_PATH_ENV,
  type PriceTable,
  parsePriceTable,
  resolvePriceTable,
} from "../src/pricing.js";
import { emptyUsage, type RunUsage } from "../src/trace.js";

/**
 * 测试自带的价目表：**不依赖真实价格**，数字都是好算的整十整百。
 *
 * 缓存价故意比 input 价便宜 10 倍，方便断言"缓存单独计价"确实生效。
 */
const TEST_TABLE: PriceTable = {
  asOf: "2024-01-01",
  source: "https://example.test/pricing",
  models: {
    "test-model": {
      inputPerMillionUsd: 100,
      cachedInputPerMillionUsd: 10,
      outputPerMillionUsd: 200,
      asOf: "2024-01-01",
    },
    "test-model-no-cache-price": {
      inputPerMillionUsd: 100,
      outputPerMillionUsd: 200,
      asOf: "2024-01-01",
    },
  },
};

function usage(overrides: Partial<RunUsage>): RunUsage {
  return { ...emptyUsage(), ...overrides };
}

/**
 * "token 完全未知"的真实形状：**根本没有 token 字段**（不是 0）。
 * `emptyUsage()` 是"已知的 0"，两者语义不同。
 */
function unknownTokens(): RunUsage {
  return { modelCalls: 1, toolCalls: 0, durationMs: 5 };
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function tempPriceFile(text: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-pricing-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "prices.json");
  await writeFile(path, text, "utf8");
  return path;
}

describe("estimateCostUsd", () => {
  it("prices input, cached input and output from the injected table", () => {
    // 1M input（其中 250k 命中缓存）+ 1M output：
    // 750k * 100/1M + 250k * 10/1M + 1M * 200/1M = 75 + 2.5 + 200
    const cost = estimateCostUsd(
      usage({ inputTokens: 1_000_000, cachedInputTokens: 250_000, outputTokens: 1_000_000 }),
      "test-model",
      TEST_TABLE,
    );

    expect(cost).toBeCloseTo(277.5, 10);
  });

  it("bills cached tokens as misses when the table has no separate cache price", () => {
    const withCached = estimateCostUsd(
      usage({ inputTokens: 1_000_000, cachedInputTokens: 900_000, outputTokens: 0 }),
      "test-model-no-cache-price",
      TEST_TABLE,
    );

    // 缓存部分并入 input 价：仍然是 1M * 100/1M。
    expect(withCached).toBeCloseTo(100, 10);
    expect(
      describeCostBasis(
        usage({ inputTokens: 1, cachedInputTokens: 1 }),
        "test-model-no-cache-price",
        TEST_TABLE,
      ),
    ).toBe("cache hits billed at input price");
  });

  it("bills unknown cache hits as misses and says so", () => {
    const cost = estimateCostUsd(
      usage({ inputTokens: 1_000_000, outputTokens: 0 }),
      "test-model",
      TEST_TABLE,
    );

    expect(cost).toBeCloseTo(100, 10);
    expect(describeCostBasis(unknownTokens(), "test-model", TEST_TABLE)).toBe(
      "cache hits unknown, billed as misses",
    );
  });

  it("returns undefined (never 0) for an unknown model or unknown tokens", () => {
    const known = usage({ inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 1_000 });

    expect(estimateCostUsd(known, "not-in-the-table", TEST_TABLE)).toBeUndefined();
    expect(describeCostBasis(known, "not-in-the-table", TEST_TABLE)).toBeUndefined();
    // usage 缺失（provider 没返回）时同样算不出，而不是按 0 计。
    expect(estimateCostUsd(unknownTokens(), "test-model", TEST_TABLE)).toBeUndefined();
    expect(
      estimateCostUsd(usage({ inputTokens: undefined, outputTokens: 5 }), "test-model", TEST_TABLE),
    ).toBeUndefined();
    expect(
      estimateCostUsd(usage({ inputTokens: 5, outputTokens: undefined }), "test-model", TEST_TABLE),
    ).toBeUndefined();
  });

  it("formats an unknown cost as unknown rather than $0.000000", () => {
    expect(formatCostUsd(undefined)).toBe("unknown");
    expect(formatCostUsd(0.000123)).toBe("$0.000123");
  });
});

describe("resolvePriceTable", () => {
  it("falls back to the built-in table and carries asOf / source", () => {
    const table = resolvePriceTable({});

    expect(table).toEqual(BUILTIN_PRICE_TABLE);
    expect(table.asOf).toBe("2026-08-23");
    expect(table.source).toContain("api-docs.deepseek.com");
    expect(table.models["deepseek-v4-flash"]?.inputPerMillionUsd).toBeGreaterThan(0);
  });

  it("lets DEEPSEEK_PRICE_TABLE_JSON override the built-in table", () => {
    const table = resolvePriceTable({
      [PRICE_TABLE_JSON_ENV]: JSON.stringify(TEST_TABLE),
    });

    expect(table).toEqual(TEST_TABLE);
    expect(
      estimateCostUsd(usage({ inputTokens: 1_000_000, outputTokens: 0 }), "test-model", table),
    ).toBeCloseTo(100, 10);
  });

  it("reads DEEPSEEK_PRICE_TABLE from a file and prefers the inline JSON", async () => {
    const path = await tempPriceFile(JSON.stringify(TEST_TABLE));
    expect(resolvePriceTable({ [PRICE_TABLE_PATH_ENV]: path })).toEqual(TEST_TABLE);

    // 两个都设置时内联 JSON 优先（顺序写进 README）。
    const inline: PriceTable = { asOf: "2024-02-02", models: {} };
    expect(
      resolvePriceTable({
        [PRICE_TABLE_PATH_ENV]: path,
        [PRICE_TABLE_JSON_ENV]: JSON.stringify(inline),
      }),
    ).toEqual(inline);

    // 空字符串视为未设置：不能把内置表顶掉。
    expect(resolvePriceTable({ [PRICE_TABLE_JSON_ENV]: "  " })).toEqual(BUILTIN_PRICE_TABLE);
  });

  it("reports readable errors instead of silently using the built-in table", async () => {
    expect(() => resolvePriceTable({ [PRICE_TABLE_JSON_ENV]: "{not json" })).toThrow(
      /DEEPSEEK_PRICE_TABLE_JSON 不是合法 JSON/,
    );

    // 结构不对（缺 outputPerMillionUsd）时给出字段路径。
    expect(() =>
      resolvePriceTable({
        [PRICE_TABLE_JSON_ENV]: JSON.stringify({
          asOf: "2024-01-01",
          models: { m: { asOf: "x", inputPerMillionUsd: 1 } },
        }),
      }),
    ).toThrow(/models\.m\.outputPerMillionUsd/);

    expect(() => resolvePriceTable({ [PRICE_TABLE_PATH_ENV]: "/nope/prices.json" })).toThrow(
      /DEEPSEEK_PRICE_TABLE=\/nope\/prices\.json 不可读/,
    );
  });

  it("parses a table from text and rejects unknown keys", () => {
    expect(parsePriceTable(JSON.stringify(TEST_TABLE), "inline")).toEqual(TEST_TABLE);
    expect(() => parsePriceTable(JSON.stringify({ ...TEST_TABLE, extra: true }), "inline")).toThrow(
      /不是合法的价格表/,
    );
  });
});
