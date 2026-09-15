import { FakeModel } from "./fake-model.js";
import { createOpenAIModel, type Model, type ResponsesClientLike } from "./model.js";

export type ModelMode = "fake" | "openai";

/**
 * 唯一装配入口。默认离线路径不读取 Key、不访问网络。
 *
 * `createOpenAIModel` 需要一个 Responses 客户端；真实项目里传 `new OpenAI()`，
 * fixture 里由测试注入结构替身，因此不需要厂商 SDK 依赖。
 */
export function createModel(
  options: { fakeReplies?: string[] | undefined; client?: ResponsesClientLike | undefined } = {},
): Model {
  const mode = (process.env.MODEL_MODE ?? "fake") as ModelMode;

  if (mode === "fake") {
    return new FakeModel(options.fakeReplies ?? ["模型已连接"]);
  }
  if (mode === "openai") {
    if (!options.client) throw new Error("openai 模式需要传入 Responses 客户端");
    return createOpenAIModel(options.client);
  }
  throw new Error(`不支持的 MODEL_MODE: ${String(mode)}`);
}
