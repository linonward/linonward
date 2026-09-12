# linonward

基于 pnpm、Turborepo 和 TypeScript 的 monorepo。

## 环境

- Node.js 24
- pnpm 12

启用 Corepack 并安装依赖：

```sh
corepack enable
pnpm install
```

## 常用命令

```sh
pnpm dev          # 启动开发任务
pnpm build        # 构建全部 workspace
pnpm lint         # 使用 ESLint 检查代码
pnpm test         # 运行全部 workspace 测试
pnpm typecheck    # TypeScript 类型检查
pnpm format       # 使用 Biome 格式化
pnpm check        # 执行 lint、类型检查、测试、构建和格式检查
```

提交前，Husky 会对暂存文件运行 lint-staged；提交信息遵循 Conventional Commits，
例如 `feat: add user profile`。

## AI 员工

`apps/feishu` 提供飞书长连接入口，并通过 GitHub Actions 中的 `claude-code-action` 执行仓库任务、将结果回帖到原话题。部署与凭据配置见
[`apps/feishu/README.md`](apps/feishu/README.md)。
