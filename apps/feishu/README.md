# 飞书 AI 员工

该服务通过飞书长连接接收授权用户的消息，触发
[`ai-employee.yml`](../../.github/workflows/ai-employee.yml) 中的 `claude-code-action`，并把最终结果回复到原飞书话题。

## 工作流程

1. 飞书用户发送文本、富文本或图片消息。
2. 本地 relay 校验用户 `open_id` 白名单，立即在话题内回复“收到，正在处理。”。
3. relay 使用一个仅有当前仓库 **Actions: write** 权限的 GitHub token 触发工作流。
4. GitHub Actions 下载附件、恢复话题对应的 Claude 会话并运行 AI 员工。
5. 独立的回帖步骤读取执行结果并用飞书凭据回复；Claude 执行步骤不会获得飞书密钥。

当任务要求交付微信公众号成稿时，AI 员工会把完整文章写入当前仓库的 GitHub Issue，
飞书只收到 Issue 链接。同一话题继续修改同一篇文章时，会更新原 Issue 并返回相同链接。

同一飞书话题会映射到同一个稳定的 Claude session UUID，并通过 GitHub Actions cache 保存会话记录。不同话题相互隔离，同一话题的任务串行执行。

## 安全模型

- 仅 `FEISHU_ALLOWED_OPEN_IDS` 中的用户可以触发任务；请保持白名单尽可能小。
- relay 的 GitHub token 只用于触发指定 workflow，不会传入 workflow。
- 飞书和 Claude 凭据只保存在本地 `.env` 或 GitHub Actions secrets 中。
- Claude 步骤不接收飞书凭据，且 `show_full_output` 关闭，避免工具输出进入 Actions 日志。
- 单条任务默认最多 6,000 字、最多 8 张图，每张图最多 20 MB。
- relay 不对飞书事件做持久化去重，应只运行一个实例。

## GitHub 配置

先将工作流合并到默认分支；GitHub 只允许 dispatch 默认分支上已经存在的 workflow。

在仓库 Settings → Secrets and variables → Actions 中添加：

- `CLAUDE_CODE_OAUTH_TOKEN`：运行 `claude setup-token` 得到的 Claude Code OAuth token。
- `LARKSUITE_CLI_APP_ID`：飞书自建应用 ID。
- `LARKSUITE_CLI_APP_SECRET`：飞书自建应用密钥。
- `AI_EMPLOYEE_PRIVATE_KEY`：下述 GitHub App 的私钥（repository secret）。
- `AI_EMPLOYEE_CLIENT_ID`：下述 GitHub App 的 client ID（repository variable）。

创建并安装一个专用于 AI 员工的 GitHub App，授予 **Contents**、**Issues** 和 **Pull requests** 读写权限。workflow 每次运行生成短期 App token，使机器人创建的分支和 PR 能正常触发 CI，同时不向 Claude 提供长期 GitHub 凭据。

另为本地 relay 创建一个仅限本仓库、只有 **Actions: write** 权限的 fine-grained personal access token，稍后填入 `GITHUB_DISPATCH_TOKEN`。这个 token 只负责触发 workflow。

## 飞书配置

1. 创建飞书自建应用并启用机器人。
2. 在事件订阅中选择“使用长连接接收事件”，订阅 `im.message.receive_v1`。
3. 授予接收消息、回复消息和读取消息资源所需权限，并发布应用版本。
4. 获取允许使用 AI 员工的用户 `open_id`，不要使用显示名称配置白名单。

长连接无需公网回调地址或入站端口。

## 本地运行

```sh
cp apps/feishu/.env.example apps/feishu/.env
# 编辑 apps/feishu/.env，填入真实配置
pnpm install
pnpm --filter @linonward/feishu dev
```

看到 `Feishu long connection established` 表示连接成功。可以先发送只读任务验证链路：

```text
只说明当前仓库默认分支和最新提交，不修改文件
```

## Docker Compose

```sh
docker compose -f apps/feishu/compose.yml up --build -d
docker compose -f apps/feishu/compose.yml logs -f
```

停止服务：

```sh
docker compose -f apps/feishu/compose.yml down
```

该服务只建立出站长连接，因此 Compose 不发布端口。

## 验证命令

```sh
pnpm --filter @linonward/feishu lint
pnpm --filter @linonward/feishu typecheck
pnpm --filter @linonward/feishu test
pnpm --filter @linonward/feishu build
node --test .github/scripts/test/*.test.mjs
```
