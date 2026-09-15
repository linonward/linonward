import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * 离线测试：全部在 node 环境里跑。
 *
 * React 渲染测试走 `react-dom/server`，因此不需要 jsdom；服务端路由测试直接起一个
 * 临时 `node:http` 监听并注入假 runner，不碰网络也不碰密钥。
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
  },
});
