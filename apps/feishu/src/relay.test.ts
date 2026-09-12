import { describe, expect, it, vi } from "vitest";

import { handleFeishuMessage, type RelayConfig } from "./relay.js";

const config: RelayConfig = {
  allowedOpenIds: new Set(["ou_authorized"]),
  maxTaskLength: 6_000,
};

describe("handleFeishuMessage", () => {
  it("acknowledges and dispatches an authorized text message", async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const reply = vi.fn().mockResolvedValue(undefined);

    await expect(
      handleFeishuMessage(
        {
          message: {
            content: JSON.stringify({ text: "  检查最新提交  " }),
            message_id: "om_message",
            message_type: "text",
            thread_id: "omt_topic",
          },
          sender: { sender_id: { open_id: "ou_authorized" } },
        },
        config,
        dispatch,
        reply,
      ),
    ).resolves.toEqual({ status: "dispatched" });

    const task = {
      messageId: "om_message",
      senderOpenId: "ou_authorized",
      text: "检查最新提交",
      threadKey: "omt_topic",
    };
    expect(reply).toHaveBeenCalledWith(task, "收到，正在处理。");
    expect(dispatch).toHaveBeenCalledWith(task);
  });

  it("uses the root message as the session key for a topic reply", async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);

    await handleFeishuMessage(
      {
        message: {
          content: JSON.stringify({ text: "继续" }),
          message_id: "om_reply",
          message_type: "text",
          root_id: "om_root",
        },
        sender: { sender_id: { open_id: "ou_authorized" } },
      },
      config,
      dispatch,
    );

    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ threadKey: "om_root" }));
  });

  it("extracts text, links, and images from rich text", async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);

    await handleFeishuMessage(
      {
        message: {
          content: JSON.stringify({
            content: [
              [
                { tag: "at", user_id: "ou_bot" },
                { tag: "text", text: "检查截图 " },
                { image_key: "img_first", tag: "img" },
              ],
              [{ href: "https://example.test/issue", tag: "a", text: "问题链接" }],
            ],
          }),
          message_id: "om_post",
          message_type: "post",
        },
        sender: { sender_id: { open_id: "ou_authorized" } },
      },
      config,
      dispatch,
    );

    expect(dispatch).toHaveBeenCalledWith({
      imageKeys: ["img_first"],
      messageId: "om_post",
      senderOpenId: "ou_authorized",
      text: "检查截图\n问题链接 (https://example.test/issue)",
      threadKey: "om_post",
    });
  });

  it("turns a standalone image into an image task", async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);

    await handleFeishuMessage(
      {
        message: {
          content: JSON.stringify({ image_key: "img_only" }),
          message_id: "om_image",
          message_type: "image",
        },
        sender: { sender_id: { open_id: "ou_authorized" } },
      },
      config,
      dispatch,
    );

    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        imageKeys: ["img_only"],
        text: "请分析附带的图片并根据图片内容完成任务。",
      }),
    );
  });

  it("ignores unauthorized and unsupported messages", async () => {
    const dispatch = vi.fn();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    await handleFeishuMessage(
      {
        message: { content: "{}", message_id: "om_audio", message_type: "audio" },
        sender: { sender_id: { open_id: "ou_authorized" } },
      },
      config,
      dispatch,
    );
    await handleFeishuMessage(
      {
        message: {
          content: JSON.stringify({ text: "run" }),
          message_id: "om_unknown",
          message_type: "text",
        },
        sender: { sender_id: { open_id: "ou_unknown" } },
      },
      config,
      dispatch,
    );

    expect(dispatch).not.toHaveBeenCalled();
    info.mockRestore();
  });

  it("reports dispatch failures in the same topic", async () => {
    const dispatch = vi.fn().mockRejectedValue(new Error("network error"));
    const reply = vi.fn().mockResolvedValue(undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await handleFeishuMessage(
      {
        message: {
          content: JSON.stringify({ text: "run" }),
          message_id: "om_message",
          message_type: "text",
        },
        sender: { sender_id: { open_id: "ou_authorized" } },
      },
      config,
      dispatch,
      reply,
    );

    expect(reply).toHaveBeenLastCalledWith(expect.anything(), "任务提交失败，请稍后重试。");
    error.mockRestore();
  });
});
