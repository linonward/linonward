export function parseMessages(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  }
}

export function extractResultText(messages) {
  if (!Array.isArray(messages)) return undefined;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type === "result" && typeof message.result === "string" && message.result.trim()) {
      return message.result.trim();
    }
  }

  return extractLatestAssistantText(messages);
}

export function formatExecutionReply(messages, runUrl) {
  const failure = findFailure(messages);
  if (!failure) return extractResultText(messages);

  const progress = extractLatestAssistantText(messages);
  const lines = [failure];
  if (progress) lines.push("", `最近进度：${progress}`);
  lines.push("", "请在当前话题回复“继续”以恢复会话并继续处理。");
  if (runUrl) lines.push(`运行日志：${runUrl}`);
  return lines.join("\n");
}

export function formatInterruptedReply(messages, runUrl) {
  const progress = extractLatestAssistantText(messages);
  const lines = ["任务未完成：运行失败、超过时间上限或已被取消。"];
  if (progress) lines.push("", `中断前的最近进度：${progress}`);
  lines.push("", "本次 runner 中未提交的修改不会进入仓库。请在当前话题回复“继续”以恢复会话。");
  if (runUrl) lines.push(`运行日志：${runUrl}`);
  return lines.join("\n");
}

function findFailure(messages) {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type !== "result" || message.is_error !== true) continue;
    return message.subtype === "error_max_turns"
      ? "任务未完成：已达到本次操作轮数上限。"
      : "任务未完成：执行过程中发生错误。";
  }
  return undefined;
}

function extractLatestAssistantText(messages) {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const content = message?.message?.content ?? message?.content;
    if (message?.type !== "assistant" || !Array.isArray(content)) continue;
    const text = content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n")
      .trim();
    if (text) return text;
  }
  return undefined;
}
