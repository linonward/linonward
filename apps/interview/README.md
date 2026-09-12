# Interview Pack｜面试作战包

一个可部署的人工交付 MVP：面向技术岗社招测试计划的落地页、面试资料提交、飞书多维表格 Lead 保存，以及面试后复盘回收。没有登录、支付、文件上传或 AI 生成能力。

## P0 闭环

1. 用户提交目标公司、技术方向、岗位、求职阶段、轮次、JD 和简历。
2. 人工按统一作战包模板交付，并保留本次准备的题目与追问链。
3. 用户面试后通过成功页中的专属链接回填实际题目、题目命中、帮助程度、卡点和结果。
4. 回访会写回同一条飞书记录，供按「公司 × 岗位 × 轮次」复盘。

人工回访时，按 `https://你的域名/feedback?leadId=<Lead ID>` 生成该用户的专属链接，并在约定面试时间后 24–48 小时发送。当前不自动发送提醒，以保留早期人工沟通和研究访谈。

飞书表格需包含以下列（列名需保持一致）：

```text
Lead ID、姓名、联系方式、目标公司、目标岗位、求职阶段、技术方向、面试轮次、面试时间、JD、简历、其他补充、状态、创建时间、更新时间、
面试状态、实际题目、题目命中、帮助程度、面试卡点、面试结果、案例授权、回访时间
```

建议在人工工作台额外记录“作战包版本 / 交付时间 / 预计回访时间”；这些是人工流程字段，不应阻塞用户提交。

## 本地运行

```bash
pnpm install
cp apps/interview/.env.example apps/interview/.env.local
pnpm turbo run dev --filter=@linonward/interview
```

以上命令均从 monorepo 根目录运行。打开 `http://localhost:3000`，并在
`apps/interview/.env.local` 中填入本地飞书多维表格的凭据和表标识。

## 验证

```bash
pnpm --filter=@linonward/interview test
pnpm turbo run lint typecheck build --filter=@linonward/interview
```

## 部署 Vercel

本项目在本地和 Vercel 均使用飞书多维表格保存 Lead，并在对应环境中设置：

```text
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_BITABLE_APP_TOKEN=xxx
FEISHU_BITABLE_TABLE_ID=xxx
```

配置后重新部署即可。API 为 `POST /api/leads`，服务端会再次用 Zod 校验。
