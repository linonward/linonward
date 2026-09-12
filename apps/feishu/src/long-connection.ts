import * as Lark from "@larksuiteoapi/node-sdk";

import type { FeishuConfig } from "./config.js";
import {
  type DispatchTask,
  handleFeishuMessage,
  type RelayConfig,
  type ReplyTask,
} from "./relay.js";

export async function startLongConnection(
  feishuConfig: FeishuConfig,
  relayConfig: RelayConfig,
  dispatch: DispatchTask,
): Promise<Lark.WSClient> {
  const messageClient = new Lark.Client({
    appId: feishuConfig.appId,
    appSecret: feishuConfig.appSecret,
  });
  const reply: ReplyTask = async (task, text) => {
    const response = await messageClient.im.v1.message.reply({
      data: {
        content: JSON.stringify({ text }),
        msg_type: "text",
        reply_in_thread: true,
      },
      path: { message_id: task.messageId },
    });
    if (response.code !== 0) {
      throw new Error(`Feishu acknowledgement failed: ${response.code ?? "unknown"}`);
    }
  };
  const eventDispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (event) =>
      handleFeishuMessage(event, relayConfig, dispatch, reply),
  });
  const client = new Lark.WSClient({
    appId: feishuConfig.appId,
    appSecret: feishuConfig.appSecret,
    loggerLevel: Lark.LoggerLevel.info,
    onError: (error) => {
      console.error("Feishu long connection stopped", error);
      process.exitCode = 1;
    },
    onReady: () => {
      console.log("Feishu long connection established");
    },
  });

  await client.start({ eventDispatcher });
  return client;
}
