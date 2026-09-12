import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import {
  formatExecutionReply,
  formatInterruptedReply,
  parseMessages,
} from "./execution-result.mjs";

const appId = process.env.LARKSUITE_CLI_APP_ID;
const appSecret = process.env.LARKSUITE_CLI_APP_SECRET;
const messageId = process.env.MESSAGE_ID;
const executionFile = process.env.EXECUTION_FILE;
const claudeOutcome = process.env.CLAUDE_OUTCOME;
const sessionUuid = process.env.SESSION_UUID;
const runUrl = process.env.RUN_URL;
const maxReplyLength = 4_000;

if (!appId || !appSecret) {
  throw new Error("LARKSUITE_CLI_APP_ID and LARKSUITE_CLI_APP_SECRET are required");
}
if (!messageId) {
  globalThis.console.log("MESSAGE_ID is missing; skipping Feishu reply");
  process.exit(0);
}

const replyText = await readReplyText();
const token = await getTenantAccessToken();
await replyToFeishu(token, messageId, replyText);
globalThis.console.log(`Replied with Claude output to Feishu message ${messageId.slice(0, 8)}…`);

async function readReplyText() {
  const candidateFiles = [executionFile, ...(await findSessionFiles(sessionUuid))].filter(Boolean);

  for (const candidateFile of candidateFiles) {
    try {
      const content = await readFile(candidateFile, "utf8");
      const messages = parseMessages(content);
      const result =
        claudeOutcome && claudeOutcome !== "success"
          ? formatInterruptedReply(messages, runUrl)
          : formatExecutionReply(messages, runUrl);
      if (result) return truncate(result);
    } catch (error) {
      globalThis.console.warn("Unable to read Claude execution output", error);
    }
  }

  return runUrl
    ? `任务已结束，但未能提取 Claude 的回复。请查看运行日志：${runUrl}`
    : "任务已结束，但未能提取 Claude 的回复。";
}

async function findSessionFiles(uuid) {
  if (!uuid) return [];
  const projectsDirectory = join(homedir(), ".claude", "projects");
  try {
    const projects = await readdir(projectsDirectory, { withFileTypes: true });
    return projects
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(projectsDirectory, entry.name, `${uuid}.jsonl`));
  } catch {
    return [];
  }
}

function truncate(text) {
  if (text.length <= maxReplyLength) return text;
  return `${text.slice(0, maxReplyLength)}\n\n…（回复过长，已截断）`;
}

async function getTenantAccessToken() {
  const response = await globalThis.fetch(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    {
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      headers: { "Content-Type": "application/json; charset=utf-8" },
      method: "POST",
    },
  );
  const payload = await response.json();
  if (!response.ok || payload.code !== 0 || typeof payload.tenant_access_token !== "string") {
    throw new Error(`Unable to obtain Feishu tenant token (status ${response.status})`);
  }
  return payload.tenant_access_token;
}

async function replyToFeishu(token, id, text) {
  const card = {
    body: { elements: [{ content: text, tag: "markdown" }] },
    schema: "2.0",
  };
  const response = await globalThis.fetch(
    `https://open.feishu.cn/open-apis/im/v1/messages/${encodeURIComponent(id)}/reply`,
    {
      body: JSON.stringify({
        content: JSON.stringify(card),
        msg_type: "interactive",
        reply_in_thread: true,
      }),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      method: "POST",
    },
  );
  const payload = await response.json();
  if (!response.ok || payload.code !== 0) {
    throw new Error(`Unable to reply to Feishu (status ${response.status})`);
  }
}
