import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createJournal, redactCredentialPatterns } from "../src/cli-journal.js";
import { makeTempDir, removeTempDir } from "./support.js";

/**
 * 日志会长期留在磁盘上：模型完全可能在回答或工具输出里带出凭证。
 * 这里覆盖"形状兜底"这一层——调用方额外提供的密钥由 `redact` 选项叠加。
 */
describe("凭证形状兜底脱敏", () => {
  it("盖掉常见 key 形状，同时留下可定位的首尾字符", () => {
    const masked = redactCredentialPatterns("key=sk-abcdefghijklmnopqrstuvwxyz0123456789 结束");

    expect(masked).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123456789");
    expect(masked).toContain("sk-a");
    expect(masked).toContain("结束");
  });

  it("password/token 这类键值保留键名，只遮住值", () => {
    const masked = redactCredentialPatterns(
      "password=hunter2secret token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
    );

    expect(masked).toContain("password=");
    expect(masked).toContain("token");
    expect(masked).not.toContain("hunter2secret");
    expect(masked).not.toContain("ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
  });

  it("Bearer 头与 JWT 都盖掉", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const masked = redactCredentialPatterns(`Authorization: Bearer ${jwt}`);

    expect(masked).toContain("Bearer ");
    expect(masked).not.toContain(jwt);
    expect(masked).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
  });

  it("普通文本与过短的值不动（宁可少遮，也不要误伤日志）", () => {
    const text = "读取 package.json：workspaces 字段不存在，token=abc 只是示例。";
    expect(redactCredentialPatterns(text)).toBe(text);
  });
});

describe("journal 写入前的脱敏", () => {
  const secret = "sk-abcdefghijklmnopqrstuvwxyz0123456789";

  async function writeAndRead(
    text: string,
    options: { redact?: ((line: string) => string) | undefined } = {},
  ): Promise<{ jsonl: string; lines: string[] }> {
    const directory = await makeTempDir("journal-redaction-");
    try {
      const logPath = join(directory, "journal.jsonl");
      const lines: string[] = [];
      const journal = createJournal({
        verbose: true,
        logPath,
        truncate: true,
        write: (line) => void lines.push(line),
        ...(options.redact === undefined ? {} : { redact: options.redact }),
      });
      journal.modelResponse({
        step: 1,
        phase: "start",
        responseId: "response-1",
        finalText: text,
        toolCalls: [],
        durationMs: 1,
      });
      journal.close();
      return { jsonl: await readFile(logPath, "utf8"), lines };
    } finally {
      await removeTempDir(directory);
    }
  }

  it("模型输出里的凭证在 JSONL 与可读行里都被盖掉", async () => {
    const { jsonl, lines } = await writeAndRead(
      `答案里带出了 ${secret}，还有 password=hunter2secret。`,
    );

    expect(jsonl).not.toContain(secret);
    expect(jsonl).not.toContain("hunter2secret");
    expect(lines.join("\n")).not.toContain(secret);
    // 日志的其余部分照旧可读。
    expect(lines.join("\n")).toContain("答案里带出了");
  });

  it("调用方提供的密钥通过 redact 叠加，形状兜底不会覆盖它", async () => {
    const custom = "custom-secret-value";
    const { jsonl } = await writeAndRead(`自定义密钥 ${custom} 与 ${secret}`, {
      redact: (line) => line.split(custom).join("***"),
    });

    expect(jsonl).not.toContain(custom);
    expect(jsonl).not.toContain(secret);
  });
});
