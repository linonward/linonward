import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ToolContext } from "../src/tool.js";
import { InMemoryWriteLease } from "../src/tool.js";
import { ToolRegistry } from "../src/tool-registry.js";
import { runCommandTool } from "../src/tools/run-command.js";

/**
 * 超时/取消后**不能留下孤儿进程**。
 *
 * `spawn(..., { signal })` 只杀直接子进程：`node -e` 里再 spawn 出来的孙进程会继续跑，
 * 于是"已经停下的运行"还在后台占着 CPU、握着端口。这里用一个真的进程树验证整组被回收。
 */

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error(`等待 ${path} 超时`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** 直接调用工具：这里只验证进程生命周期，不走策略与批准。 */
async function runNodeScript(script: string, signal: AbortSignal): Promise<unknown> {
  const registry = new ToolRegistry();
  registry.register(runCommandTool);
  const tool = registry.get("run_command");
  if (tool === undefined) throw new Error("run_command 未注册");

  const context: ToolContext = {
    cwd: process.cwd(),
    signal,
    writeLease: new InMemoryWriteLease(),
    skills: { catalog: [], activeSkills: {} },
    maxSkillBytes: 1_000,
    emit: () => undefined,
  };
  return tool.prepare({ command: "node", args: ["-e", script] }).execute(context);
}

describe("run_command 的进程组回收", () => {
  it("工具超时后，子进程与孙进程都不再存活", async () => {
    const directory = await mkdtemp(join(tmpdir(), "run-command-orphan-"));
    try {
      const pidFile = join(directory, "pids.json");
      const script = [
        "const fs=require('fs');const {spawn}=require('child_process');",
        "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});",
        `fs.writeFileSync(${JSON.stringify(pidFile)},JSON.stringify({parent:process.pid,child:child.pid}));`,
        "setInterval(()=>{},1000);",
      ].join("");

      // 外部取消：等价于用户点了"中止运行"。
      const controller = new AbortController();
      const result = runNodeScript(script, controller.signal);

      await waitForFile(pidFile);
      const pids = JSON.parse(readFileSync(pidFile, "utf8")) as { parent: number; child: number };
      expect(alive(pids.parent)).toBe(true);
      expect(alive(pids.child)).toBe(true);

      controller.abort();
      await result;

      // 给内核一点时间回收；两者都必须消失。
      const deadline = Date.now() + 5_000;
      while ((alive(pids.parent) || alive(pids.child)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(alive(pids.parent)).toBe(false);
      expect(alive(pids.child)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 20_000);
});
