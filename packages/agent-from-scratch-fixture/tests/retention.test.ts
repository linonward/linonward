import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseRetentionDays, pruneRuns } from "../src/retention.js";

/**
 * 运行目录只会越攒越多：每次运行都会留下检查点、事件日志与 journal。生产环境必须能
 * 按保留期清理，而且清理必须是"可见、可解释"的——删了什么、留下什么都要能说出来。
 */
describe("运行目录保留策略", () => {
  const now = new Date("2024-06-01T00:00:00.000Z");

  async function withRoot(
    seed: (root: string) => Promise<void>,
    run: (root: string) => Promise<void>,
  ): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "agent-retention-"));
    try {
      await seed(root);
      await run(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }

  /** 造一个"运行目录"，其内容文件的 mtime 就是这次运行的年龄。 */
  async function seedRun(root: string, name: string, ageDays: number): Promise<string> {
    const directory = join(root, name);
    await mkdir(join(directory, "checkpoints"), { recursive: true });
    const file = join(directory, "journal.jsonl");
    await writeFile(file, "{}\n", "utf8");
    const when = new Date(now.getTime() - ageDays * 24 * 60 * 60 * 1_000);
    await utimes(file, when, when);
    await utimes(join(directory, "checkpoints"), when, when);
    return directory;
  }

  it("超过保留期的运行被删除，未超过的原地不动", async () => {
    await withRoot(
      async (root) => {
        await seedRun(root, "old-run", 10);
        await seedRun(root, "fresh-run", 1);
      },
      async (root) => {
        const result = await pruneRuns(root, { maxAgeMs: 7 * 24 * 60 * 60 * 1_000, now });

        expect(result.removed).toEqual(["old-run"]);
        expect(result.kept).toBe(1);
        await expect(stat(join(root, "old-run"))).rejects.toThrow();
        await expect(stat(join(root, "fresh-run", "journal.jsonl"))).resolves.toBeDefined();
      },
    );
  });

  it("dryRun 只报告不删除；根目录不存在时不报错", async () => {
    await withRoot(
      async (root) => {
        await seedRun(root, "old-run", 30);
      },
      async (root) => {
        const dry = await pruneRuns(root, { maxAgeMs: 1_000, now, dryRun: true });
        expect(dry.removed).toEqual(["old-run"]);
        await expect(stat(join(root, "old-run"))).resolves.toBeDefined();

        const missing = await pruneRuns(join(root, "does-not-exist"), { maxAgeMs: 1_000, now });
        expect(missing).toMatchObject({ removed: [], kept: 0 });
      },
    );
  });

  it("根目录下的普通文件不会被当成运行删掉", async () => {
    await withRoot(
      async (root) => {
        await writeFile(join(root, "README.md"), "别删我", "utf8");
        await seedRun(root, "old-run", 30);
      },
      async (root) => {
        const result = await pruneRuns(root, { maxAgeMs: 1_000, now });

        expect(result.removed).toEqual(["old-run"]);
        await expect(stat(join(root, "README.md"))).resolves.toBeDefined();
      },
    );
  });

  it("保留期环境变量：非法值报错，缺省不清理，0 表示按天计的最新值", () => {
    expect(parseRetentionDays({})).toBeUndefined();
    expect(parseRetentionDays({ AGENT_RETENTION_DAYS: "30" })).toBe(30);
    expect(parseRetentionDays({ AGENT_RETENTION_DAYS: "0" })).toBe(0);
    expect(() => parseRetentionDays({ AGENT_RETENTION_DAYS: "-1" })).toThrow("非负整数");
    expect(() => parseRetentionDays({ AGENT_RETENTION_DAYS: "abc" })).toThrow("非负整数");
  });

  it("保留期 0 天：所有已经结束的运行都会被清掉", async () => {
    await withRoot(
      async (root) => {
        await seedRun(root, "any-run", 0.01);
      },
      async (root) => {
        const result = await pruneRuns(root, { maxAgeMs: 0, now });
        expect(result.removed).toEqual(["any-run"]);
      },
    );
  });
});
