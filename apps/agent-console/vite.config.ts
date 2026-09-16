import path from "node:path";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** 仓库根。fixture 的源码在 `packages/` 下，属于 Vite 工作目录之外，必须显式放行。 */
const workspaceRoot = path.resolve(import.meta.dirname, "..", "..");

/** 本地 API 服务地址；与 `server/index.ts` 的默认端口保持一致。 */
const apiPort = process.env.AGENT_CONSOLE_API_PORT ?? "8787";
const apiTarget = `http://127.0.0.1:${apiPort}`;

export default defineConfig({
  plugins: [react()],
  server: {
    // 只监听回环地址：这是本地工具，不对外暴露。
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    fs: { allow: [workspaceRoot] },
    // 前端只发相对路径的 `/api/...`，由 Vite 转发到本地 API 服务。
    proxy: { "/api": { target: apiTarget, changeOrigin: false } },
  },
  optimizeDeps: {
    // fixture 的 exports 指向 TS 源码：预打包会绕过 Vite 的 TS 转换，所以直接排除。
    exclude: ["@linonward/agent-from-scratch-fixture"],
  },
  build: { outDir: "dist", emptyOutDir: true },
});
