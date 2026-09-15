# Agent Tutorial

一个使用 Next.js 与 MDX 构建的中文教程，带领读者从最小模型调用开始，逐步实现可执行、可验证、可控的本地工程 Agent。

## 本地运行

从仓库根目录执行：

```sh
pnpm turbo run dev --filter=@linonward/tutorial
```

默认打开 `http://localhost:3000`。如果其他 Next.js 应用占用了端口，请使用终端输出中的实际地址。

## 内容结构

- `src/content/*.mdx`：主线 18 章正文，按 `00`–`17` 编号，是一条累积的搭建路径。
- `src/content/extensions/*.mdx`：扩展篇 6 章，复用主线边界但不是主线 Capstone 的前置条件。
- `src/lib/chapters.ts`：主线章节的**唯一有序事实源**，顺序即学习顺序，编号由数组下标派生。
- `src/lib/extensions.ts`：扩展篇的唯一有序事实源，并导出 `tutorialExtensions` 摘要视图。
- `src/app/extensions/page.tsx`：扩展篇入口页；扩展章节复用 `/[slug]` 路由。
- `src/mdx-components.tsx`：MDX 可用的交互组件。
- `src/components/`：教程阅读界面。
- `tests/`：结构契约、代码块签名断言与跨章接口测试。

## 可执行参考实现

`packages/agent-from-scratch-fixture` 是主线 18 章的可执行版本：它实现了教程逐章搭出来的 Harness、工具链、状态机、规划、权限、Skills、Agent Loop、压缩与崩溃恢复，并提供各章 Checkpoint 点名的 13 个测试文件。

```sh
pnpm turbo run test typecheck lint --filter=@linonward/agent-from-scratch-fixture
```

`tests/fixture-coverage.test.ts` 会校验"Checkpoint 引用的测试文件真实存在"，因此正文与 fixture 之间不会静默漂移。

## 新增章节时

1. 新建 `src/content/<slug>.mdx`（扩展篇放在 `src/content/extensions/`），使用 `LessonOverview` / `Step` / `Checkpoint` 教学契约；
2. 在 `src/lib/chapters.ts`（或 `src/lib/extensions.ts`）的**有序定义数组**中登记，并让 `toc` 的 id 与正文锚点一一对应；
3. 需要时在 `tests/` 增加章节契约测试；结构性契约与内容承诺的分工见 `tests/lesson-structure.test.ts` 与 `tests/content-promises.test.ts` 的注释。

章节顺序、锚点顺序、Step 编号与 Checkpoint 位置都由测试固定，避免导航与正文意外错位。
