# Agent Tutorial

一个使用 Next.js 与 MDX 构建的中文教程，带领读者从最小模型调用开始，逐步实现可执行、可验证、可控的本地工程 Agent。

## 本地运行

从仓库根目录执行：

```sh
pnpm turbo run dev --filter=@linonward/tutorial
```

默认打开 `http://localhost:3000`。如果其他 Next.js 应用占用了端口，请使用终端输出中的实际地址。

## 内容结构

- `src/content/*.mdx`：章节正文。
- `src/lib/chapters.ts`：章节顺序、描述与本页目录。
- `src/mdx-components.tsx`：MDX 可用的交互组件。
- `src/components/`：教程阅读界面。

新增章节时，需要同时添加 MDX 文件和章节目录项。章节顺序由测试固定，避免导航与正文意外错位。
