const supportedMessageTypes = new Set(["image", "post", "text"]);
const maxImages = 8;

export type Task = {
  imageKeys?: string[];
  messageId: string;
  senderOpenId: string;
  text: string;
  threadKey: string;
};

export type RelayConfig = {
  allowedOpenIds: ReadonlySet<string>;
  maxTaskLength: number;
};

export type DispatchTask = (task: Task) => Promise<void>;
export type ReplyTask = (task: Task, text: string) => Promise<void>;

export type FeishuMessageEvent = {
  message: {
    content: string;
    message_id: string;
    message_type: string;
    root_id?: string;
    thread_id?: string;
  };
  sender: {
    sender_id?: {
      open_id?: string;
    };
  };
};

export async function handleFeishuMessage(
  event: FeishuMessageEvent,
  config: RelayConfig,
  dispatch: DispatchTask,
  reply: ReplyTask = async () => undefined,
): Promise<{ status: "dispatched" | "ignored" }> {
  if (!supportedMessageTypes.has(event.message.message_type)) {
    console.info("Ignoring unsupported Feishu message type", {
      messageId: event.message.message_id,
      messageType: event.message.message_type,
    });
    return { status: "ignored" };
  }

  const senderOpenId = event.sender.sender_id?.open_id;
  if (!senderOpenId || !config.allowedOpenIds.has(senderOpenId)) {
    console.info("Ignoring unauthorized Feishu sender", {
      messageId: event.message.message_id,
      openId: senderOpenId ?? "missing",
    });
    return { status: "ignored" };
  }

  const task = getTask(event.message, config.maxTaskLength, senderOpenId);
  if (!task) return { status: "ignored" };

  try {
    await reply(task, "收到，正在处理。");
  } catch (error) {
    console.error("Unable to acknowledge Feishu message", error);
  }

  try {
    await dispatch(task);
  } catch (error) {
    console.error("Unable to dispatch Feishu task", error);
    await reply(task, "任务提交失败，请稍后重试。");
  }

  return { status: "dispatched" };
}

function getTask(
  message: FeishuMessageEvent["message"],
  maxTaskLength: number,
  senderOpenId: string,
): Task | undefined {
  const content = parseMessageContent(message.message_type, message.content);
  if (!content) return undefined;

  const text = content.text.trim();
  if (
    (!text && content.imageKeys.length === 0) ||
    text.length > maxTaskLength ||
    content.imageKeys.length > maxImages
  ) {
    return undefined;
  }

  return {
    ...(content.imageKeys.length > 0 ? { imageKeys: content.imageKeys } : {}),
    messageId: message.message_id,
    senderOpenId,
    text: text || "请分析附带的图片并根据图片内容完成任务。",
    threadKey: message.thread_id ?? message.root_id ?? message.message_id,
  };
}

function parseMessageContent(
  messageType: string,
  content: string,
): { imageKeys: string[]; text: string } | undefined {
  try {
    const value: unknown = JSON.parse(content);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;

    if (messageType === "text") {
      return typeof record.text === "string"
        ? { imageKeys: [], text: record.text.replaceAll(/@_user_\d+/g, " ") }
        : undefined;
    }
    if (messageType === "image") {
      return typeof record.image_key === "string"
        ? { imageKeys: [record.image_key], text: "" }
        : undefined;
    }
    return parsePostContent(record);
  } catch {
    return undefined;
  }
}

function parsePostContent(record: Record<string, unknown>): { imageKeys: string[]; text: string } {
  const localized = Object.values(record).find(isPostBody);
  const body = isPostBody(record) ? record : localized;
  if (!body) return { imageKeys: [], text: "" };

  const imageKeys: string[] = [];
  const lines = body.content.flatMap((line) => {
    if (!Array.isArray(line)) return [];
    const text = line
      .flatMap((element) => {
        if (typeof element !== "object" || element === null || Array.isArray(element)) return [];
        const node = element as Record<string, unknown>;
        if (node.tag === "img" && typeof node.image_key === "string") {
          imageKeys.push(node.image_key);
          return [];
        }
        if (node.tag === "text" && typeof node.text === "string") return [node.text];
        if (node.tag === "a" && typeof node.href === "string") {
          return [typeof node.text === "string" ? `${node.text} (${node.href})` : node.href];
        }
        return [];
      })
      .join("")
      .trim();
    return text ? [text] : [];
  });

  return { imageKeys, text: lines.join("\n") };
}

function isPostBody(value: unknown): value is { content: unknown[] } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Array.isArray((value as Record<string, unknown>).content)
  );
}
