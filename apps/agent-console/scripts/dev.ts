import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";

/**
 * `pnpm dev`：同时拉起 Vite（5173）与本地 API 服务（8787）。
 *
 * 两个进程都用 `stdio: "inherit"`，任一退出就一起收摊；`Ctrl-C` 也会转发给它们。
 * API 服务通过 `--env-file-if-exists=.env` 读取密钥（文件不存在也能跑起来）。
 */
const root = join(import.meta.dirname, "..");
const children: ChildProcess[] = [];
let stopping = false;

function stop(code: number): void {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  process.exitCode = code;
}

function launch(command: string, args: string[]): ChildProcess {
  const child = spawn(command, args, { cwd: root, stdio: "inherit", env: process.env });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (stopping) return;
    process.stderr.write(
      `[dev] ${command} 退出（code=${code ?? "null"} signal=${signal ?? "null"}），一起停止。\n`,
    );
    stop(code ?? 1);
  });
  return child;
}

launch(process.execPath, ["--env-file-if-exists=.env", "--import", "tsx", "server/index.ts"]);
launch(join(root, "node_modules", ".bin", "vite"), []);

process.once("SIGINT", () => stop(0));
process.once("SIGTERM", () => stop(0));
